// How the page talks to the service when sending. The page depends only on
// the `Sender` interface, so component tests (seam 2) swap in a fake; the real
// one is headless Uppy with its tus plugin (#20): a Submission is started on
// the service, each file goes up in chunks into it, then one JSON call hands
// the arrived file to ResourceSpace.
import Uppy from "@uppy/core";
import Tus from "@uppy/tus";
import { isRefusal, type Refusal } from "../shared/media.ts";

export interface SendDetails {
  title: string;
  rightsConfirmed: true;
}

export interface SendEvents {
  /** Percent of the file that has reached the service, 0 to 100. */
  onProgress: (percent: number) => void;
  /** The whole file has arrived; the service is handing it to ResourceSpace. */
  onFinishing: () => void;
}

export type SendResult =
  | { ok: true }
  /**
   * A Refusal: the service will not take this file (it looked inside, or the
   * Submission has no room); sending it again will not help. failed:
   * anything else; trying again may work.
   */
  | { ok: false; reason: Refusal | "failed" };

export interface Submission {
  /**
   * Sends one file into this Submission. Calling it again for the same file
   * after a failure resumes and never duplicates. The page decides how many
   * are sent at once.
   */
  send(file: File, details: SendDetails, events: SendEvents): Promise<SendResult>;
}

export interface Sender {
  /** A new Submission: everything sent through it is grouped together. */
  begin(): Submission;
}

const SUBMISSIONS_ENDPOINT = "/upload/api/submissions";
const FILES_ENDPOINT = "/upload/api/files/";
const ITEMS_ENDPOINT = "/upload/api/items";

/** #17: small chunks (5–8 MB) keep each request well inside Traefik's 60 s read timeout. */
const CHUNK_SIZE = 5 * 1024 * 1024;

/** How often the page asks how a hand-off is going while it shows Finishing up (#55). */
const POLL_EVERY_MS = 3000;
/** Asks in a row that may go unanswered (a blip in the connection) before it counts as failed: about a minute. */
const POLL_MISSES = 20;

/** The service's reason for refusing a file, from a JSON `{error}` body, if it gave one. */
function refusalIn(body: unknown): Refusal | undefined {
  if (typeof body !== "string") return undefined;
  try {
    const error = (JSON.parse(body) as { error?: unknown }).error;
    return isRefusal(error) ? error : undefined;
  } catch {
    return undefined;
  }
}

export function createSender(): Sender {
  return { begin: createSubmission };
}

function createSubmission(): Submission {
  const uppy = new Uppy({ autoProceed: false }).use(Tus, {
    endpoint: FILES_ENDPOINT,
    chunkSize: CHUNK_SIZE,
    // The full retry schedule and its states are #58; this rides out a blip.
    retryDelays: [0, 1000, 3000, 5000],
    // The page sends two at a time; this is only a backstop.
    limit: 2,
    // Only the file's name and the Submission go to the service (as metadata it treats as untrusted).
    allowedMetaFields: ["name", "submission"],
    // Resuming after the tab is closed is out of scope (#20).
    storeFingerprintForResuming: false,
    removeFingerprintOnSuccess: true,
  });

  // Why the service refused an upload when it started, by Uppy file id.
  const refused = new Map<string, Refusal>();
  uppy.on("upload-error", (file, error, response) => {
    const original = (error as { originalResponse?: { getBody?: () => unknown } } | undefined)?.originalResponse;
    const body = original?.getBody?.() ?? (response?.body as { xhr?: XMLHttpRequest } | undefined)?.xhr?.responseText;
    const refusal = refusalIn(body);
    if (file && refusal) refused.set(file.id, refusal);
  });

  // The Submission's id on the service, asked for once, when the first file is sent.
  let submissionId: Promise<string | undefined> | undefined;
  async function submission(): Promise<string | undefined> {
    submissionId ??= fetch(SUBMISSIONS_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
      .then(async (res) => (res.status === 201 ? ((await res.json()) as { submissionId?: string }).submissionId : undefined))
      .catch(() => undefined);
    const id = await submissionId;
    // Ask again next time rather than remember a failure.
    if (!id) submissionId = undefined;
    return id;
  }

  // Each file being sent: Uppy's id for it, and the service's upload id once
  // it has fully arrived (so trying again only repeats the hand-off).
  const sending = new Map<File, { fileId: string; uploadId?: string }>();
  let added = 0;

  /** The upload id once the whole file has arrived, the reason the service refused it, or nothing (it may work next time). */
  async function upload(file: File, onProgress: (p: number) => void): Promise<{ uploadId: string } | { refusal: Refusal } | undefined> {
    const known = sending.get(file);
    if (known?.uploadId) return { uploadId: known.uploadId };
    let entry = known;
    const progress = (f: { id: string } | undefined, p: { bytesUploaded: number; bytesTotal: number | null }) => {
      if (f && f.id === entry?.fileId && p.bytesTotal) onProgress(Math.floor((p.bytesUploaded / p.bytesTotal) * 100));
    };
    uppy.on("upload-progress", progress);
    try {
      let result;
      if (entry) {
        // Resumes from the last chunk the service confirmed.
        refused.delete(entry.fileId);
        result = await uppy.retryUpload(entry.fileId);
      } else {
        const id = await submission();
        if (!id) return undefined;
        entry = {
          fileId: uppy.addFile({
            name: file.name,
            type: file.type,
            data: file,
            source: "local",
            // Never sent (not an allowed meta field): it only keeps Uppy from
            // treating two files with the same name, size and date as one.
            meta: { submission: id, relativePath: `item-${++added}` },
          }),
        };
        sending.set(file, entry);
        result = await uppy.upload();
      }
      const fileId = entry.fileId;
      const done = result?.successful?.find((f) => f.id === fileId);
      const url = done?.uploadURL ?? done?.response?.uploadURL;
      const refusal = refused.get(fileId);
      if (!url) return refusal ? { refusal } : undefined;
      entry.uploadId = url.split("/").filter(Boolean).pop();
      return entry.uploadId ? { uploadId: entry.uploadId } : undefined;
    } catch {
      const refusal = entry && refused.get(entry.fileId);
      return refusal ? { refusal } : undefined;
    } finally {
      uppy.off("upload-progress", progress);
    }
  }

  return {
    async send(file, details, events) {
      const uploaded = await upload(file, events.onProgress);
      if (uploaded && "refusal" in uploaded) return { ok: false, reason: uploaded.refusal };
      if (!uploaded) return { ok: false, reason: "failed" };
      events.onProgress(100);
      events.onFinishing();
      return handOver(uploaded.uploadId, details);
    },
  };
}

/**
 * Asks the service to hand an arrived file to ResourceSpace, and waits until
 * ResourceSpace has it. A big video takes minutes there, so the service may
 * answer 202 "finishing" at once; then the Item's status is polled (#55).
 */
export async function handOver(uploadId: string, details: SendDetails, pollEveryMs = POLL_EVERY_MS): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetch(ITEMS_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uploadId, ...details }),
    });
  } catch {
    // The connection dropped while waiting: the hand-off may be under way
    // all the same, so ask how it is going.
    return finished(uploadId, pollEveryMs);
  }
  if (res.status === 202) return finished(uploadId, pollEveryMs);
  if (res.ok) return { ok: true };
  return { ok: false, reason: refusalIn(await res.text().catch(() => "")) ?? "failed" };
}

/** Polls the Item's status until the hand-off is over. "failed" lets the member try again, which picks up where it stopped. */
async function finished(uploadId: string, pollEveryMs: number): Promise<SendResult> {
  let misses = 0;
  while (misses < POLL_MISSES) {
    await new Promise((resolve) => setTimeout(resolve, pollEveryMs));
    let body: { status?: unknown; error?: unknown };
    try {
      const res = await fetch(`${ITEMS_ENDPOINT}/${encodeURIComponent(uploadId)}`, { credentials: "same-origin" });
      if (res.status === 404) return { ok: false, reason: "failed" };
      if (!res.ok) throw new Error(`status ${res.status}`);
      body = (await res.json()) as typeof body;
    } catch {
      misses++;
      continue;
    }
    misses = 0;
    if (body.status === "sent") return { ok: true };
    if (body.status === "refused" && isRefusal(body.error)) return { ok: false, reason: body.error };
    if (body.status !== "finishing") return { ok: false, reason: "failed" };
  }
  return { ok: false, reason: "failed" };
}
