// Handing a fully arrived upload to ResourceSpace as one Item in Pending
// Review (ADR 0002), with the Title and the six Submitter fields.
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
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.ts";
import { detectPhotoFile } from "./filetype.ts";
import { fileName, newSubmissionId, originalFileName, rightsRecord } from "./naming.ts";
import type { ResourceSpace } from "./resourcespace.ts";
import type { SessionUser } from "./session.ts";
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
  | { outcome: "not_a_photo"; sizeBytes?: number }
  | { outcome: "not_saved"; record?: ItemRecord; error: string };

export interface ItemRecord {
  owner: string;
  submissionId: string;
  /** The rights statement and when it was confirmed, as written to ResourceSpace. */
  rights: string;
  sizeBytes: number;
  detectedType: string;
  fileName: string;
  ref?: number;
  fileUploaded?: boolean;
  sent?: boolean;
}

export interface Items {
  handOff(req: HandOffRequest, submitter: Submitter): Promise<HandOffResult>;
}

export function createItems(
  config: Config,
  deps: { uploads: Uploads; rs: ResourceSpace; now?: () => Date },
): Items {
  const { uploads, rs } = deps;
  const now = deps.now ?? (() => new Date());
  const inFlight = new Map<string, Promise<HandOffResult>>();

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
      const type = await detectPhotoFile(upload.path);
      if (!type) {
        await uploads.remove(upload.id);
        return { outcome: "not_a_photo", sizeBytes: upload.size };
      }
      const submissionId = newSubmissionId();
      record = {
        owner: user.id,
        submissionId,
        rights: rightsRecord(now()),
        sizeBytes: upload.size,
        detectedType: type.mime,
        // One photo per Submission for now (#53), so it is Item 001. No Date
        // field yet (#56), so the name has none.
        fileName: fileName({ title: req.title, submissionId, itemNumber: 1, extension: type.extension }),
      };
    }

    try {
      if (record.ref === undefined) {
        record.ref = await rs.createPendingItem(config.rsPhotoResourceType);
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
      const previous = inFlight.get(req.uploadId) ?? Promise.resolve(undefined);
      const next = previous.catch(() => undefined).then(() => run(req, submitter));
      inFlight.set(req.uploadId, next);
      const done = () => {
        if (inFlight.get(req.uploadId) === next) inFlight.delete(req.uploadId);
      };
      next.then(done, done);
      return next;
    },
  };
}

/** The ProClass member number, or "volunteer" for a volunteer without one (#19). */
export function memberIdFor(user: SessionUser): string {
  if (user.memberId) return user.memberId;
  return user.claims.includes("volunteer") ? "volunteer" : "(none)";
}
