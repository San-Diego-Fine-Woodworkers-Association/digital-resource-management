// The staging volume (ADR 0004): how full it is, whether another chunk fits,
// and the sweep that keeps it from filling with what nobody will finish.
//
// Room. The service stops itself at STAGING_CAP_PERCENT of the volume (80%,
// about 40 GB of 50, #23), and before each chunk checks the bytes it carries
// still fit under that cap and in the space actually free. Past either, the
// member is told the service is busy (503), and nothing is written. Several
// chunks checked at the same moment can each pass, so the cap may be
// overshot by a few chunks; the 20% above it is far more than that.
//
// The sweep. What is on staging, by name (every name is made by the
// service; nothing else is ever touched, so a mistaken STAGING_DIR cannot
// cost anyone their files):
//
//   <upload id>, <upload id>.json   a photo or video and tus's record of it
//   <upload id>.item.json           its hand-off record (items.ts)
//   <submission id>.submission.json a Submission's answers (submissions.ts)
//   <submission id>.notify.json     its Reviewers' email (notify.ts, #61)
//   ....item.json.tmp, ....submission.json.tmp, ....notify.json.tmp   a record being written
//
// Kept while anyone may still need it, removed 24 hours after that (#23):
//   - an upload, while it has had a chunk (or a hand-off step) in the last
//     24 hours: it can still be resumed or tried again. After that it is
//     abandoned, and goes with its hand-off record. One that got as far as
//     ResourceSpace is logged with its ref, for a Reviewer to clear.
//   - a hand-off record whose upload is gone (sent, or given up), for 24
//     hours: a repeated hand-off still answers "sent", and the page's status
//     poll still has its answer.
//   - a Submission's record, while any upload on staging belongs to it or it
//     took one in the last 24 hours, and for 24 hours after it was started;
//     and always while its Reviewers' email is still to go (#61).
//   - the state of a Submission's Reviewers' email, while it is still to go,
//     and for 24 hours after it went.
//
// Leftovers, at startup only, when nothing else is running: half an upload
// (bytes without tus's record or the other way round), an upload whose
// record is not one the service wrote, and records half-written when the
// service stopped. While running, these are only removed once an hour old,
// since an upload being created has its two halves for a moment.
import { lstat, readdir, readFile, statfs, unlink } from "node:fs/promises";
import path from "node:path";
import { isSubmissionId } from "./naming.ts";

export interface VolumeStats {
  totalBytes: number;
  /** Free to anyone, root included. */
  freeBytes: number;
  /** Free to the service's (non-root) user. */
  availableBytes: number;
}

export type VolumeStatsOf = (dir: string) => Promise<VolumeStats>;

export const statVolume: VolumeStatsOf = async (dir) => {
  const fs = await statfs(dir);
  return { totalBytes: fs.blocks * fs.bsize, freeBytes: fs.bfree * fs.bsize, availableBytes: fs.bavail * fs.bsize };
};

/** Kept free beyond the chunk itself, for the small records written beside it. */
const MARGIN_BYTES = 16 * 1024 * 1024;

export const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;
/** A leftover found while the service is running is only removed once this old. */
const LEFTOVER_AFTER_MS = 60 * 60 * 1000;

const UPLOAD = /^[0-9a-f]{32}$/;
const UPLOAD_INFO = /^([0-9a-f]{32})\.json$/;
const ITEM = /^([0-9a-f]{32})\.item\.json$/;
const SUBMISSION = /^([a-z0-9]{12})\.submission\.json$/;
const NOTIFY = /^([a-z0-9]{12})\.notify\.json$/;
const PARTIAL = /^(?:[0-9a-f]{32}\.item|[a-z0-9]{12}\.(?:submission|notify))\.json\.tmp$/;

/** An upload on staging, as tus recorded it. */
export interface StagedUpload {
  id: string;
  owner: string;
  submissionId: string;
  size: number;
  offset: number;
}

export interface SweepReport {
  removed: string[];
  /** Uploads still on staging afterwards. */
  uploads: StagedUpload[];
}

export interface SweepOptions {
  /** At startup, when nothing else is writing: leftovers go whatever their age. */
  startup?: boolean;
  /** Whether a Submission is still taking uploads (submissions.ts). */
  inUse?: (submissionId: string) => boolean;
  /** Whether a Submission's Reviewers' email is still to go (notify.ts): its record and state stay. */
  pending?: (submissionId: string) => boolean;
  /** An upload was removed, so whatever counts it can stop counting it. */
  onRemoved?: (upload: StagedUpload) => void;
}

export interface Staging {
  stats(): Promise<VolumeStats>;
  /** Whether `incoming` more bytes fit under the cap and in the free space. */
  room(incoming: number): Promise<boolean>;
  sweep(opts?: SweepOptions): Promise<SweepReport>;
}

interface Entry {
  name: string;
  mtimeMs: number;
  size: number;
}

export function createStaging(opts: {
  dir: string;
  capPercent: number;
  stats?: VolumeStatsOf;
  now?: () => number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}): Staging {
  const { dir, capPercent } = opts;
  const stats = () => (opts.stats ?? statVolume)(dir);
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  let sweeping: Promise<SweepReport> | undefined;

  async function room(incoming: number): Promise<boolean> {
    let s: VolumeStats;
    try {
      s = await stats();
    } catch {
      return false;
    }
    const used = s.totalBytes - s.freeBytes;
    return used + incoming <= (s.totalBytes * capPercent) / 100 && incoming + MARGIN_BYTES <= s.availableBytes;
  }

  async function entries(): Promise<Map<string, Entry>> {
    const found = new Map<string, Entry>();
    for (const name of await readdir(dir)) {
      if (!UPLOAD.test(name) && !UPLOAD_INFO.test(name) && !ITEM.test(name) && !SUBMISSION.test(name) && !NOTIFY.test(name) && !PARTIAL.test(name)) continue;
      try {
        const st = await lstat(path.join(dir, name));
        // Only plain files the service made; never a directory or a link.
        if (st.isFile()) found.set(name, { name, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // gone meanwhile
      }
    }
    return found;
  }

  async function readJson(name: string): Promise<Record<string, unknown> | undefined> {
    try {
      const v: unknown = JSON.parse(await readFile(path.join(dir, name), "utf8"));
      return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }

  /** tus's record of an upload, if it is one the service made. */
  function uploadOf(id: string, info: Record<string, unknown> | undefined, bytes: number): StagedUpload | undefined {
    const meta = info?.metadata as Record<string, unknown> | undefined;
    const owner = meta?.owner;
    const submissionId = meta?.submission;
    const size = info?.size;
    if (info?.id !== id || typeof owner !== "string" || !owner) return undefined;
    if (typeof submissionId !== "string" || !isSubmissionId(submissionId)) return undefined;
    if (typeof size !== "number" || !Number.isInteger(size) || size < 0) return undefined;
    return { id, owner, submissionId, size, offset: bytes };
  }

  async function sweepOnce(o: SweepOptions): Promise<SweepReport> {
    const t = now();
    const found = await entries();
    const removed: string[] = [];
    const remove = async (name: string) => {
      try {
        await unlink(path.join(dir, name));
        removed.push(name);
      } catch {
        // already gone
      }
      found.delete(name);
    };
    /** Removes a hand-off record; one that stopped partway is logged with its ref (or the unanswered create), for a Reviewer to clear. */
    const forgetItem = async (e: Entry) => {
      const record = await readJson(e.name);
      if (typeof record?.ref === "number" && record.sent !== true) {
        log("gave up on an Item partway to ResourceSpace: it is in Pending Review without everything", {
          uploadId: e.name.slice(0, 32),
          ref: record.ref,
          submissionId: record.submissionId,
        });
      } else if (typeof record?.creatingSince === "string" && record.ref === undefined) {
        // ResourceSpace never answered the create (#58): it may have made an empty Item.
        log("gave up on an Item whose create got no answer from ResourceSpace: it may hold an empty Item from it", {
          uploadId: e.name.slice(0, 32),
          submissionId: record.submissionId,
          askedAt: record.creatingSince,
        });
      }
      await remove(e.name);
    };
    const old = (e: Entry | undefined, ms: number) => !!e && t - e.mtimeMs > ms;
    const leftover = (e: Entry | undefined) => !!e && (o.startup || old(e, LEFTOVER_AFTER_MS));

    for (const e of [...found.values()]) if (PARTIAL.test(e.name) && leftover(e)) await remove(e.name);

    const uploads: StagedUpload[] = [];
    const ids = new Set([...found.keys()].flatMap((n) => (UPLOAD.test(n) ? [n] : UPLOAD_INFO.test(n) ? [n.slice(0, 32)] : [])));
    for (const id of ids) {
      const data = found.get(id);
      const infoEntry = found.get(`${id}.json`);
      const item = found.get(`${id}.item.json`);
      const upload = data && infoEntry ? uploadOf(id, await readJson(`${id}.json`), data.size) : undefined;
      if (!upload) {
        // Half an upload, or not one the service made: nothing can use it.
        if (leftover(data ?? infoEntry)) {
          for (const n of [id, `${id}.json`]) if (found.has(n)) await remove(n);
        }
        continue;
      }
      const lastActive = Math.max(data!.mtimeMs, infoEntry!.mtimeMs, item?.mtimeMs ?? 0);
      if (t - lastActive <= ABANDONED_AFTER_MS) {
        uploads.push(upload);
        continue;
      }
      if (item) await forgetItem(item);
      await remove(id);
      await remove(`${id}.json`);
      o.onRemoved?.(upload);
    }

    // Hand-off records whose upload is gone: a day for the page to hear how it went.
    for (const e of [...found.values()]) {
      if (ITEM.test(e.name) && !found.has(e.name.slice(0, 32)) && old(e, ABANDONED_AFTER_MS)) await forgetItem(e);
    }

    const wanted = new Set(uploads.map((u) => u.submissionId));
    for (const e of [...found.values()]) {
      const id = SUBMISSION.exec(e.name)?.[1];
      if (!id || wanted.has(id) || o.inUse?.(id) || o.pending?.(id) || !old(e, ABANDONED_AFTER_MS)) continue;
      await remove(e.name);
    }
    for (const e of [...found.values()]) {
      const id = NOTIFY.exec(e.name)?.[1];
      if (!id || o.pending?.(id) || !old(e, ABANDONED_AFTER_MS)) continue;
      await remove(e.name);
    }

    if (removed.length > 0) log("staging sweep", { startup: !!o.startup, removed: removed.length, kept: uploads.length });
    return { removed, uploads };
  }

  return {
    stats,
    room,
    sweep(o = {}) {
      // One at a time: a slow sweep is not started again on top of itself.
      sweeping ??= sweepOnce(o).finally(() => {
        sweeping = undefined;
      });
      return sweeping;
    },
  };
}
