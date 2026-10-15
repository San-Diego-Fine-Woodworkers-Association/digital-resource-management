// Handing a fully arrived upload to ResourceSpace as one Item in Pending
// Review (ADR 0002), as a Photo or a Video by its content, with the member's
// answers from Step 2 and the six Submitter fields.
//
// Idempotent (#30): the ResourceSpace ref is recorded next to the staged file
// (`<upload id>.item.json`) as soon as the Item exists, and each later step is
// recorded as it succeeds. Trying again after any failure picks up where it
// stopped and reuses the same Item; it never creates a second one. Once
// ResourceSpace has confirmed everything, the staged file is deleted and only
// that small record remains, so a repeated request still answers "sent".
//
// One window is left (#58): if ResourceSpace makes the Item but its answer
// never arrives (the call times out, or the service stops before it writes
// the ref down), the ref is unknown. So the record notes when a create was
// asked for before asking, and a later try that finds that note without a ref
// logs that ResourceSpace may hold an empty Item from it. That Item has no
// file and no answers (both only ever go to the recorded ref), so it is
// never a second copy of the photo, only an empty one for a Reviewer to
// clear.
//
// When ResourceSpace answers with a failure, the hand-off tries again by
// itself a couple of times before it reports "not_saved" (#30: Couldn't save
// is what is left after the service's own retries). A call ResourceSpace
// never answered is not tried again here: it already waited the whole
// timeout, and a file upload that timed out took many minutes.
//
// The answers and the rights confirmation come from the Submission's record,
// checked when the Submission was started (#56); the Submitter fields only
// from the verified session and the server itself. From the browser come
// just the device's file name (kept as Original Filename) and, on the
// hand-off, the page's name for the Item: an Item changed in Step 3 gets its
// own answers from the record, any other the Step 2 ones (#57). Which
// answers an Item gets is settled when its record is made, so a retried
// hand-off writes the same ones.
//
// ResourceSpace's API does not enforce required fields, and drops a choice it
// does not know without saying so (ADR 0003). So after writing, the service
// reads the Item back and confirms every field it wrote holds what was
// written, and that each choice is still one ResourceSpace offers. Anything that does not is written again, up to 3 times; if it still
// does not hold, that is logged and the Item counts as received anyway: a
// Reviewer fills the gap at Approval.
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
import { setTimeout as sleep } from "node:timers/promises";
import type { Details, Options } from "../shared/details.ts";
import { checkFile, type MediaKind, type Refusal } from "../shared/media.ts";
import type { Config } from "./config.ts";
import { detectFile } from "./filetype.ts";
import { fileName, originalFileName } from "./naming.ts";
import type { Notifier } from "./notify.ts";
import type { LiveOptions } from "./options.ts";
import { ResourceSpaceError, type ResourceSpace } from "./resourcespace.ts";
import type { SessionUser } from "./session.ts";
import type { SubmissionRecord, Submissions } from "./submissions.ts";
import { isUploadId, type UploadInfo, type Uploads } from "./uploads.ts";

export interface HandOffRequest {
  uploadId: string;
  /** The page's name for the Item, which says whose answers it gets if it was changed in Step 3 (#57). */
  item?: string;
}

/** How many times the read-back writes a field again before giving up on it. */
export const READ_BACK_RETRIES = 3;

/** The pauses before the hand-off tries ResourceSpace again after it answered with a failure (#30, #58). */
export const RS_RETRY_DELAYS_MS = [1000, 3000];

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
  /** Set when the Item has its own answers in the Submission's record (#57). */
  item?: string;
  fileName: string;
  /** When a create was last asked for whose answer has not arrived (#58). */
  creatingSince?: string;
  ref?: number;
  fileUploaded?: boolean;
  sent?: boolean;
  /** Fields the read-back could not confirm after every retry (logged; a Reviewer fills them in). */
  unconfirmed?: string[];
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
  deps: {
    uploads: Uploads;
    submissions: Submissions;
    rs: ResourceSpace;
    options: LiveOptions;
    log: (message: string, fields?: Record<string, unknown>) => void;
    /** Told as each hand-off works and when an Item is in, for the Reviewers' email (#61). */
    notifier?: Pick<Notifier, "progress" | "itemSent">;
    /** The pause before the first read-back retry; it grows with each one. */
    retryDelayMs?: number;
    /** The pauses before trying ResourceSpace again after a failure it answered with. */
    rsRetryDelaysMs?: number[];
    now?: () => Date;
  },
): Items {
  const { uploads, submissions, rs, options, log } = deps;
  const now = deps.now ?? (() => new Date());
  const retryDelayMs = deps.retryDelayMs ?? 500;
  const rsRetryDelaysMs = deps.rsRetryDelaysMs ?? RS_RETRY_DELAYS_MS;
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
    if (record?.sent) {
      // Told again: harmless, and it covers a stop between the two.
      await deps.notifier?.itemSent(record.submissionId, req.uploadId, record.kind);
      return { outcome: "sent", record };
    }

    const upload = await uploads.find(req.uploadId, user);
    if (!upload) return { outcome: "not_found" };
    if (upload.size === undefined || upload.offset !== upload.size) return { outcome: "incomplete" };
    const submission = await submissions.record(upload.submissionId, user.id);
    if (!submission) {
      log("no record of the Submission for an upload", { uploadId: upload.id, submissionId: upload.submissionId });
      return { outcome: "not_found" };
    }
    // An Item changed in Step 3 has its own answers; a retry keeps whichever it got first.
    const own = (key: string | undefined) => (key !== undefined && submission.items && Object.hasOwn(submission.items, key) ? key : undefined);
    const item = own(record ? record.item : req.item);
    const details = item !== undefined ? submission.items![item]! : submission.details;

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
        rights: submission.rights,
        sizeBytes: upload.size,
        detectedType: type.mime,
        kind: type.kind,
        ...(item !== undefined ? { item } : {}),
        // This Item's Date, or none: never guessed from the upload day.
        fileName: fileName({ date: details.date, title: details.title, submissionId, itemNumber, extension: type.extension }),
      };
    }

    for (let attempt = 0; ; attempt++) {
      // A hand-off under way is progress: a long video's previews take minutes.
      deps.notifier?.progress(record.submissionId);
      try {
        await toResourceSpace(upload, record, details, submission, submitter);
        break;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        const pause = rsRetryDelaysMs[attempt];
        if (pause === undefined || (err instanceof ResourceSpaceError && err.unanswered)) {
          return { outcome: "not_saved", record, error };
        }
        log("ResourceSpace failed during a hand-off; trying again", { uploadId: upload.id, ref: record.ref, attempt: attempt + 1, error });
        await sleep(pause);
      }
    }

    await uploads.remove(upload.id, { sent: true });
    await deps.notifier?.itemSent(record.submissionId, upload.id, record.kind);
    return { outcome: "sent", record };
  }

  /** Every step to ResourceSpace not yet done for this Item, each recorded as it succeeds. */
  async function toResourceSpace(
    upload: UploadInfo & { path: string },
    record: ItemRecord,
    details: Details,
    submission: SubmissionRecord,
    submitter: Submitter,
  ) {
    const { user } = submitter;
    if (record.ref === undefined) {
      if (record.creatingSince) {
        log("an earlier try at making this Item got no answer from ResourceSpace: it may hold an empty Item from it", {
          uploadId: upload.id,
          submissionId: record.submissionId,
          askedAt: record.creatingSince,
        });
      }
      // Noted before asking, so an answer that never arrives is not forgotten.
      record.creatingSince = now().toISOString();
      await saveRecord(upload.id, record);
      try {
        record.ref = await rs.createPendingItem(
          record.kind === "video" ? config.rsVideoResourceType : config.rsPhotoResourceType,
        );
      } catch (err) {
        // ResourceSpace answered, so it made nothing.
        if (err instanceof ResourceSpaceError && !err.unanswered) {
          delete record.creatingSince;
          await saveRecord(upload.id, record);
        }
        throw err;
      }
      delete record.creatingSince;
      await saveRecord(upload.id, record);
    }
    if (!record.fileUploaded) {
      await rs.uploadFile(record.ref, upload.path, record.fileName, record.detectedType);
      record.fileUploaded = true;
      await saveRecord(upload.id, record);
    }
    // Written after the file, so nothing ResourceSpace reads from the photo's
    // own metadata can overwrite them. Empty answers are not written at all:
    // a blank Date would wipe the date ResourceSpace read from the photo.
    const fields: [string, string][] = [
      ...answerFields(details),
      ["submittername", submitter.name],
      ["submitteremail", user.email],
      ["submittermemberid", memberIdFor(user)],
      ["submissionid", record.submissionId],
      ["submitterrights", record.rights],
      ["submitterfilename", originalFileName(upload.originalName)],
    ];
    for (const [field, value] of fields) await rs.updateField(record.ref, field, value);
    const unconfirmed = await readBack(record.ref, fields, submission);
    if (unconfirmed.length > 0) record.unconfirmed = unconfirmed;
    record.sent = true;
    await saveRecord(upload.id, record);
  }

  /**
   * Reads the Item back and writes again whatever does not hold, up to
   * READ_BACK_RETRIES times. Never fails the hand-off: what is still wrong at
   * the end is logged and returned.
   */
  async function readBack(ref: number, written: [string, string][], submission: SubmissionRecord): Promise<string[]> {
    // Every field written, not only the required ones: one request reads them
    // all, and an optional answer lost (a place deactivated since the page
    // loaded) is worth a line in the log too. Checked against RS 11.0 r29660:
    // each comes back exactly as written, Subject Type as "A, B".
    let wrong = written.map(([field]) => field);
    let lastError: string | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        // The choices as they are now, not as cached: one deactivated since
        // the member chose it is still saved by ResourceSpace, and only this
        // catches it.
        const [values, live] = await Promise.all([rs.fieldValues(ref), options.get(0)]);
        wrong = written.filter(([field, value]) => !holds(field, value, values[field], live)).map(([field]) => field);
        lastError = undefined;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      if (wrong.length === 0 || attempt === READ_BACK_RETRIES) break;
      await sleep(retryDelayMs * (attempt + 1));
      for (const [field, value] of written) {
        if (!wrong.includes(field)) continue;
        try {
          await rs.updateField(ref, field, value);
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
        }
      }
    }
    if (wrong.length > 0) {
      log("fields not confirmed on the Item after retrying; counted as received", {
        ref,
        submissionId: submission.submissionId,
        fields: wrong,
        retries: READ_BACK_RETRIES,
        error: lastError,
      });
    }
    return wrong;
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

/** The member's answers as ResourceSpace fields, by shortname, leaving out the empty ones. */
export function answerFields(d: Details): [string, string][] {
  const fields: [string, string][] = [
    ["title", d.title],
    ["programevent", d.programevent],
    // A checkbox list is written as its choices' names, comma-separated.
    ["subjecttype", d.subjecttype.join(",")],
    ["date", d.date],
    ["location", d.location],
    ["eventname", d.eventname],
    ["caption", d.caption],
  ];
  return fields.filter(([, value]) => value !== "");
}

/** Whether a field read back holds what was written, and (for a choice) is one ResourceSpace still offers. */
function holds(field: string, written: string, read: string | undefined, live: Options): boolean {
  if (read === undefined) return false;
  if (field === "subjecttype") {
    // Read back as "A, B": compared as sets of names.
    const want = written.split(",");
    const got = read.split(",").map((s) => s.trim()).filter(Boolean);
    return want.length === got.length && want.every((w) => got.includes(w) && live.subjecttype.includes(w));
  }
  if (field === "programevent" || field === "location") return read === written && live[field].includes(written);
  return read === written;
}

/** The ProClass member number, or "volunteer" for a volunteer without one (#19). */
export function memberIdFor(user: SessionUser): string {
  if (user.memberId) return user.memberId;
  return user.claims.includes("volunteer") ? "volunteer" : "(none)";
}
