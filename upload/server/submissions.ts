// The Submissions members are sending (#54): which uploads belong to each, so
// the per-Submission limits (#18) hold whatever the page does, and the
// Submission ID and Item numbers every Item is stored under.
//
// The page asks for a new Submission when the member presses Send, then puts
// its id on every upload. The id is made here and checked against the member
// on every use, so nobody can add to someone else's Submission or choose an
// id themselves.
//
// Each Submission has a record (#56): its id and short code, who started it
// and when, how many Items the page said it would send, and the answers from
// Step 2 with the rights confirmation, already checked (app.ts), and the
// answers of each Item changed in Step 3 (#57). Every Item in it is written
// from this record. The record is also kept on the staging
// volume, so Items already uploaded still get their answers after a restart.
//
// The limits are checked twice, because a file's kind is only known once its
// bytes have arrived:
//   - when an upload starts: the number of Items and the total size, from the
//     size the upload declares (tus never lets it grow past that);
//   - when it is handed over: the number of videos, from its content.
//
// The room taken is held in memory, like the daily quotas (#23). After a
// restart the service forgets it: uploads already made still hand over (their
// Submission ID is stamped on them, and the record is read back from disk),
// but new ones into a forgotten Submission are refused, and the page starts a
// new one next time.
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Details } from "../shared/details.ts";
import type { Limits, Refusal } from "../shared/media.ts";
import { checkRoom } from "../shared/media.ts";
import { isSubmissionId, newSubmissionId, submissionCode } from "./naming.ts";
import type { SessionUser } from "./session.ts";

/** A Submission nobody has added to for this long is forgotten. Matches the staging sweep (#23). */
const FORGET_AFTER_MS = 24 * 60 * 60 * 1000;

interface Submission {
  owner: string;
  touchedAt: number;
  /** Declared size of each upload made into it, by upload id. */
  uploads: Map<string, number>;
  /** Uploads accepted as videos. */
  videos: Set<string>;
  nextItemNumber: number;
  record?: SubmissionRecord;
}

/** What a Submission is, as the service keeps it (#56). */
export interface SubmissionRecord {
  submissionId: string;
  /** The short code in its Items' file names. */
  code: string;
  /** The session user id of the member who started it. */
  owner: string;
  createdAt: string;
  /** How many photos and videos the page said it would send. */
  expectedItems: number;
  /** The Step 2 answers, checked, for every Item. */
  details: Details;
  /**
   * The full answers of each Item changed in Step 3, checked, by the page's
   * name for the Item, which its hand-off repeats (#57). Any other Item uses
   * `details`.
   */
  items?: Record<string, Details>;
  /** The rights statement and when it was confirmed, as written on every Item. */
  rights: string;
}

export interface Start {
  expectedItems: number;
  details: Details;
  items?: Record<string, Details>;
  rights: string;
}

export type Reservation = { itemNumber: number } | { refusal: Refusal } | { unknown: true };

export interface Submissions {
  /** A new, empty Submission for this member, with its record. */
  create(user: SessionUser, start: Start): Promise<SubmissionRecord>;
  /** The record of one of this member's Submissions, if it is known. */
  record(submissionId: string, owner: string): Promise<SubmissionRecord | undefined>;
  /**
   * Room for one more upload of `size` bytes: reserves it and gives its Item
   * number, or says why not. `unknown` when the id is not one of this
   * member's Submissions.
   */
  reserve(submissionId: string, user: SessionUser, uploadId: string, size: number): Reservation;
  /**
   * The upload's content has been checked: counts it as a video if it is
   * one, or refuses it when the Submission already has as many as it can
   * take. Idempotent per upload.
   */
  accept(submissionId: string, owner: string, uploadId: string, kind: "photo" | "video"): Refusal | "not_found" | undefined;
  /** Frees the room an upload took (it was refused or abandoned). */
  release(submissionId: string, uploadId: string): void;
  /** Whether it may still take uploads: its record must stay on staging (the sweep, staging.ts). */
  inUse(submissionId: string): boolean;
}

export function createSubmissions(
  limits: Limits,
  opts: { now?: () => number; dir?: string } = {},
): Submissions {
  const now = opts.now ?? Date.now;
  const all = new Map<string, Submission>();

  const recordPath = (dir: string, id: string) => path.join(dir, `${id}.submission.json`);

  async function saveRecord(record: SubmissionRecord) {
    if (!opts.dir) return;
    const file = recordPath(opts.dir, record.submissionId);
    await writeFile(`${file}.tmp`, JSON.stringify(record), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }

  async function loadRecord(id: string): Promise<SubmissionRecord | undefined> {
    if (!opts.dir || !isSubmissionId(id)) return undefined;
    try {
      return JSON.parse(await readFile(recordPath(opts.dir, id), "utf8")) as SubmissionRecord;
    } catch {
      return undefined;
    }
  }

  function forgetOld() {
    const cutoff = now() - FORGET_AFTER_MS;
    for (const [id, s] of all) if (s.touchedAt < cutoff) all.delete(id);
  }

  return {
    async create(user, start) {
      forgetOld();
      let id = newSubmissionId();
      while (all.has(id)) id = newSubmissionId();
      const record: SubmissionRecord = {
        submissionId: id,
        code: submissionCode(id),
        owner: user.id,
        createdAt: new Date(now()).toISOString(),
        ...start,
      };
      await saveRecord(record);
      all.set(id, { owner: user.id, touchedAt: now(), uploads: new Map(), videos: new Set(), nextItemNumber: 1, record });
      return record;
    },

    async record(submissionId, owner) {
      const s = all.get(submissionId);
      if (s?.record) return s.record.owner === owner ? s.record : undefined;
      const record = await loadRecord(submissionId);
      if (!record || record.owner !== owner) return undefined;
      if (s) s.record = record;
      return record;
    },

    reserve(submissionId, user, uploadId, size) {
      const s = all.get(submissionId);
      if (!s || s.owner !== user.id) return { unknown: true };
      let bytes = 0;
      for (const b of s.uploads.values()) bytes += b;
      const refusal = checkRoom(undefined, size, { items: s.uploads.size, videos: s.videos.size, bytes }, limits);
      if (refusal) return { refusal };
      s.uploads.set(uploadId, size);
      s.touchedAt = now();
      return { itemNumber: s.nextItemNumber++ };
    },

    accept(submissionId, owner, uploadId, kind) {
      let s = all.get(submissionId);
      // Forgotten (a restart): the id and owner come from the upload's own
      // server-stamped record, so carry on with what is known from here.
      if (!s) {
        s = { owner, touchedAt: now(), uploads: new Map(), videos: new Set(), nextItemNumber: 1 };
        all.set(submissionId, s);
      }
      if (s.owner !== owner) return "not_found";
      s.touchedAt = now();
      if (kind !== "video" || s.videos.has(uploadId)) return undefined;
      if (s.videos.size >= limits.maxVideos) return "too_many_videos";
      s.videos.add(uploadId);
      return undefined;
    },

    release(submissionId, uploadId) {
      const s = all.get(submissionId);
      if (!s) return;
      s.uploads.delete(uploadId);
      s.videos.delete(uploadId);
    },

    inUse(submissionId) {
      forgetOld();
      return all.has(submissionId);
    },
  };
}
