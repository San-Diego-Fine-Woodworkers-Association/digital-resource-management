// Handing a fully arrived upload to ResourceSpace as one Item in Pending
// Review (ADR 0002), as a Photo or a Video by its content, with the Title and
// the six Submitter fields.
//
// Idempotent (#30): the ResourceSpace ref is recorded next to the staged file
// (`<upload id>.item.json`) as soon as the Item exists, and each later step is
// recorded as it succeeds. Trying again after any failure picks up where it
// stopped and reuses the same Item; it never creates a second one. Once
// ResourceSpace has confirmed everything, the staged file is deleted and only
// that small record remains, so a repeated request still answers "sent".
//
// The Submitter fields come only from the verified session and the server
// itself. From the browser come just the Title, the rights tick, and the
// device's file name (kept as Original Filename).
//
// A big video takes ResourceSpace minutes to take in (it makes the previews
// before it answers), so a hand-off runs to the end whoever is still
// waiting: the page's request may stop waiting, and `status` says where it
// has got to (#55). Only one runs per upload at a time.
//
// Before anything reaches ResourceSpace, the file's content is checked
// against the allowlist and the limits that depend on what it is (#18, #54):
// a type we take, not too big for its kind, and room in its Submission for
// another video. A refused file is deleted from staging at once.
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkFile, type MediaKind, type Refusal } from "../shared/media.ts";
import type { Config } from "./config.ts";
import { detectFile } from "./filetype.ts";
import { fileName, originalFileName, rightsRecord } from "./naming.ts";
import type { ResourceSpace } from "./resourcespace.ts";
import type { SessionUser } from "./session.ts";
import type { Submissions } from "./submissions.ts";
import { isUploadId, type Uploads } from "./uploads.ts";

/** The longest Title accepted. ResourceSpace's title field holds far more; this only stops abuse. */
export const MAX_TITLE = 200;

export interface HandOffRequest {
  uploadId: string;
  title: string;
  rightsConfirmed: boolean;
}

export interface Submitter {
  user: SessionUser;
  /** Display name from the auth service (or the email). */
  name: string;
}

export type HandOffResult =
  | { outcome: "sent"; record: ItemRecord }
  | { outcome: "not_found" }
  | { outcome: "incomplete" }
  | { outcome: "refused"; refusal: Refusal; sizeBytes?: number; detectedType?: string }
  | { outcome: "not_saved"; record?: ItemRecord; error: string };

export interface ItemRecord {
  owner: string;
  submissionId: string;
  /** The rights statement and when it was confirmed, as written to ResourceSpace. */
  rights: string;
  sizeBytes: number;
  detectedType: string;
  kind: MediaKind;
  fileName: string;
  ref?: number;
  fileUploaded?: boolean;
  sent?: boolean;
}

/** Where an Item is, for the page to poll while it shows Finishing up (#55). */
export type ItemStatus =
  /** Being handed to ResourceSpace now. */
  | { status: "finishing" }
  | { status: "sent" }
  /** The last hand-off did not finish; asking again picks up where it stopped. */
  | { status: "not_saved" }
  | { status: "refused"; refusal: Refusal }
  /** Fully arrived, and not handed over yet. */
  | { status: "arrived" }
  /** Still arriving. */
  | { status: "incomplete" }
  | { status: "not_found" };

export interface Items {
  handOff(req: HandOffRequest, submitter: Submitter): Promise<HandOffResult>;
  /** Where this member's upload is. Never starts anything. */
  status(uploadId: string, user: SessionUser): Promise<ItemStatus>;
}

/** How long the outcome of a hand-off that did not end in "sent" is remembered. Matches the staging sweep (#23). */
const REMEMBER_FOR_MS = 24 * 60 * 60 * 1000;

export function createItems(
  config: Config,
  deps: { uploads: Uploads; submissions: Submissions; rs: ResourceSpace; now?: () => Date },
): Items {
  const { uploads, submissions, rs } = deps;
  const now = deps.now ?? (() => new Date());
  // By member and upload id: only the owner's hand-off ever does anything,
  // so nobody else's request can make it look busy or failed.
  const inFlight = new Map<string, Promise<HandOffResult>>();
  /** The last hand-off of each upload that did not end in "sent" (a refused file leaves nothing on disk). */
  const outcomes = new Map<string, { result: HandOffResult; at: number }>();
  const keyOf = (uploadId: string, user: SessionUser) => `${user.id} ${uploadId}`;

  function remember(key: string, result: HandOffResult) {
    const cutoff = now().getTime() - REMEMBER_FOR_MS;
    for (const [k, o] of outcomes) if (o.at < cutoff) outcomes.delete(k);
    if (result.outcome === "sent") outcomes.delete(key);
    else outcomes.set(key, { result, at: now().getTime() });
  }

  const recordPath = (id: string) => path.join(config.stagingDir, `${id}.item.json`);

  async function readRecord(id: string): Promise<ItemRecord | undefined> {
    try {
      return JSON.parse(await readFile(recordPath(id), "utf8")) as ItemRecord;
    } catch {
      return undefined;
    }
  }

  async function saveRecord(id: string, record: ItemRecord) {
    const tmp = `${recordPath(id)}.tmp`;
    await writeFile(tmp, JSON.stringify(record), { mode: 0o600 });
    await rename(tmp, recordPath(id));
  }

  async function run(req: HandOffRequest, submitter: Submitter): Promise<HandOffResult> {
    const { user } = submitter;
    let record = await readRecord(req.uploadId);
    if (record && record.owner !== user.id) return { outcome: "not_found" };
    if (record?.sent) return { outcome: "sent", record };

    const upload = await uploads.find(req.uploadId, user);
    if (!upload) return { outcome: "not_found" };
    if (upload.size === undefined || upload.offset !== upload.size) return { outcome: "incomplete" };

    if (!record) {
      const type = await detectFile(upload.path);
      const refusal =
        checkFile(type, upload.size, config.limits) ??
        (type && submissions.accept(upload.submissionId, upload.owner, upload.id, type.kind));
      if (refusal === "not_found") return { outcome: "not_found" };
      if (refusal || !type) {
        await uploads.remove(upload.id);
        submissions.release(upload.submissionId, upload.id);
        return { outcome: "refused", refusal: refusal ?? "wrong_type", sizeBytes: upload.size, detectedType: type?.mime };
      }
      const { submissionId, itemNumber } = upload;
      record = {
        owner: user.id,
        submissionId,
        rights: rightsRecord(now()),
        sizeBytes: upload.size,
        detectedType: type.mime,
        kind: type.kind,
        // No Date field yet (#56), so the name has none.
        fileName: fileName({ title: req.title, submissionId, itemNumber, extension: type.extension }),
      };
    }

    try {
      if (record.ref === undefined) {
        record.ref = await rs.createPendingItem(
          record.kind === "video" ? config.rsVideoResourceType : config.rsPhotoResourceType,
        );
        await saveRecord(upload.id, record);
      }
      if (!record.fileUploaded) {
        await rs.uploadFile(record.ref, upload.path, record.fileName, record.detectedType);
        record.fileUploaded = true;
        await saveRecord(upload.id, record);
      }
      // Written after the file, so nothing ResourceSpace reads from the photo's
      // own metadata can overwrite them.
      const fields: [string, string][] = [
        ["title", req.title],
        ["submittername", submitter.name],
        ["submitteremail", user.email],
        ["submittermemberid", memberIdFor(user)],
        ["submissionid", record.submissionId],
        ["submitterrights", record.rights],
        ["submitterfilename", originalFileName(upload.originalName)],
      ];
      for (const [field, value] of fields) await rs.updateField(record.ref, field, value);
      record.sent = true;
      await saveRecord(upload.id, record);
    } catch (err) {
      return { outcome: "not_saved", record, error: err instanceof Error ? err.message : String(err) };
    }

    await uploads.remove(upload.id);
    return { outcome: "sent", record };
  }

  return {
    handOff(req, submitter) {
      if (!isUploadId(req.uploadId)) return Promise.resolve({ outcome: "not_found" });
      // One hand-off per upload at a time: a second request waits for the
      // first and then answers from its record.
      const key = keyOf(req.uploadId, submitter.user);
      const previous = inFlight.get(key) ?? Promise.resolve(undefined);
      const next = previous.catch(() => undefined).then(() => run(req, submitter));
      inFlight.set(key, next);
      const done = (result: HandOffResult) => {
        if (inFlight.get(key) !== next) return;
        inFlight.delete(key);
        remember(key, result);
      };
      next.then(done, (err: unknown) => done({ outcome: "not_saved", error: err instanceof Error ? err.message : String(err) }));
      return next;
    },

    async status(uploadId, user) {
      if (!isUploadId(uploadId)) return { status: "not_found" };
      const key = keyOf(uploadId, user);
      if (inFlight.has(key)) return { status: "finishing" };
      const record = await readRecord(uploadId);
      if (record && record.owner !== user.id) return { status: "not_found" };
      if (record?.sent) return { status: "sent" };
      const last = outcomes.get(key)?.result;
      if (last?.outcome === "refused") return { status: "refused", refusal: last.refusal };
      // A record without "sent" is a hand-off that stopped partway, perhaps
      // before a restart.
      if (last?.outcome === "not_saved" || record) return { status: "not_saved" };
      const upload = await uploads.find(uploadId, user);
      if (!upload) return { status: "not_found" };
      if (upload.size === undefined || upload.offset !== upload.size) return { status: "incomplete" };
      return { status: "arrived" };
    },
  };
}

/** The ProClass member number, or "volunteer" for a volunteer without one (#19). */
export function memberIdFor(user: SessionUser): string {
  if (user.memberId) return user.memberId;
  return user.claims.includes("volunteer") ? "volunteer" : "(none)";
}
