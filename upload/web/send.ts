// How the page talks to the service when sending. The page depends only on
// the `Sender` interface, so component tests (seam 2) swap in a fake; the real
// one is headless Uppy with its tus plugin (#20): a Submission is started on
// the service with the Step 2 answers and each changed Item's own (which it
// checks), each file goes up in chunks into it, then one JSON call hands the
// arrived file to ResourceSpace, naming its Item (#57).
//
// It does not try again by itself (#58): it says why a send stopped, and the
// page (itemState.ts) decides when to try again. "connection" is the
// connection, or the service behind it, not answering; trying the same send
// again resumes the file from what the service already has, or repeats only
// the hand-off, which never makes a second Item.
import Uppy from "@uppy/core";
import Tus from "@uppy/tus";
import type { Changes, Details, FieldProblem, ItemProblem, Options } from "../shared/details.ts";
import { isBusy, isRefusal, type Refusal } from "../shared/media.ts";

/** What starts a Submission: how many will be sent, the Step 2 answers and the rights confirmation. */
export interface Start {
  expectedItems: number;
  details: Details;
  /** What each Item changed in Step 3, by its key (#57); only the Items that changed something. */
  items?: Record<string, Changes>;
  rightsConfirmed: true;
}

export type BeginResult =
  | { ok: true; submission: Submission }
  /**
   * The service did not take the answers (a choice is no longer offered);
   * with the choices as they are now. A problem with one Item's own answer
   * names the Item.
   */
  | { ok: false; reason: "invalid"; problems: (FieldProblem | ItemProblem)[]; options?: Options }
  | { ok: false; reason: "failed" };

export type OptionsResult = { ok: true; options: Options } | { ok: false };

export interface SendEvents {
  /** Percent of the file that has reached the service, 0 to 100. */
  onProgress: (percent: number) => void;
  /**
   * The whole file has arrived; the service is handing it to ResourceSpace.
   * On a send tried again after the file arrived, only once the service has
   * answered, so it always means the service is reachable.
   */
  onFinishing: () => void;
}

export type SendResult =
  | { ok: true }
  /**
   * A Refusal: the service will not take this file (it looked inside, or the
   * Submission has no room); sending it again will not help. busy: the
   * service cannot take it just now (#60); trying again later will.
   * connection: no answer, or none from the service itself (#58); trying
   * again soon should work. failed: anything else; trying again may work.
   */
  | { ok: false; reason: Refusal | "busy" | "connection" | "failed" };

export interface Submission {
  /**
   * Sends one file into this Submission as the Item with this key, which says
   * whose answers it gets (#57). Calling it again for the same file after a
   * failure resumes and never duplicates. The page decides how many are sent
   * at once.
   */
  send(file: File, events: SendEvents, item: string): Promise<SendResult>;
  /**
   * The page reached its end with at least one sent: the service sends the
   * Reviewers' email now, as partial if some are missing (#61). Fire and
   * forget: never waited for, never shown.
   */
  finished?(): void;
}

export interface Sender {
  /** The live choices for the list fields in Step 2. */
  options(): Promise<OptionsResult>;
  /** A new Submission with these answers: everything sent through it is grouped together. */
  begin(start: Start): Promise<BeginResult>;
}

const OPTIONS_ENDPOINT = "/upload/api/options";
const SUBMISSIONS_ENDPOINT = "/upload/api/submissions";
const FILES_ENDPOINT = "/upload/api/files/";
const ITEMS_ENDPOINT = "/upload/api/items";

/** #17: small chunks (5–8 MB) keep each request well inside Traefik's 60 s read timeout. */
const CHUNK_SIZE = 5 * 1024 * 1024;

/** How often the page asks how a hand-off is going while it shows Finishing up (#55). */
const POLL_EVERY_MS = 3000;

/** The `error` of a JSON `{error}` body: an answer from the service itself. */
function errorIn(body: unknown): unknown {
  if (typeof body !== "string") return undefined;
  try {
    return (JSON.parse(body) as { error?: unknown }).error;
  } catch {
    return undefined;
  }
}

/** The service's reason for refusing a file, or that it is busy, from a JSON `{error}` body, if it gave one. */
function refusalIn(body: unknown): Refusal | "busy" | undefined {
  const error = errorIn(body);
  return isRefusal(error) ? error : isBusy(error) ? "busy" : undefined;
}

/**
 * Why a request the service did not succeed with stopped: its own reason if
 * it gave one (a 502 "not_saved" is ResourceSpace failing, not the
 * connection); the connection when nothing answered (status 0) or something
 * in front of the service did (a bare 502, 503 or 504 from the proxy while it
 * restarts); otherwise failed.
 */
export function failureOf(status: number, body: unknown): Exclude<SendResult, { ok: true }>["reason"] {
  const reason = refusalIn(body);
  if (reason) return reason;
  if (typeof errorIn(body) === "string") return "failed";
  if (status === 0 || status === 502 || status === 503 || status === 504) return "connection";
  return "failed";
}

export function createSender(): Sender {
  return {
    async options() {
      try {
        const res = await fetch(OPTIONS_ENDPOINT, { credentials: "same-origin" });
        if (!res.ok) return { ok: false };
        return { ok: true, options: ((await res.json()) as { options: Options }).options };
      } catch {
        return { ok: false };
      }
    },

    async begin(start) {
      try {
        const res = await fetch(SUBMISSIONS_ENDPOINT, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(start),
        });
        if (res.status === 201) {
          const { submissionId } = (await res.json()) as { submissionId?: string };
          return submissionId ? { ok: true, submission: createSubmission(submissionId) } : { ok: false, reason: "failed" };
        }
        if (res.status === 422) {
          const body = (await res.json()) as { error?: string; problems?: (FieldProblem | ItemProblem)[]; options?: Options };
          if (body.error === "invalid_details" && Array.isArray(body.problems)) {
            return { ok: false, reason: "invalid", problems: body.problems, options: body.options };
          }
        }
        return { ok: false, reason: "failed" };
      } catch {
        return { ok: false, reason: "failed" };
      }
    },
  };
}

function createSubmission(submissionId: string): Submission {
  const uppy = new Uppy({ autoProceed: false }).use(Tus, {
    endpoint: FILES_ENDPOINT,
    chunkSize: CHUNK_SIZE,
    // None here: the page tries again on its own schedule and shows it as
    // Connection trouble (#58). Uppy's own retries would hide the trouble, and
    // while the browser says it is offline they wait for it with no limit.
    retryDelays: [],
    // The page sends two at a time; this is only a backstop.
    limit: 2,
    // Only the file's name and the Submission go to the service (as metadata it treats as untrusted).
    allowedMetaFields: ["name", "submission"],
    // Resuming after the tab is closed is out of scope (#20).
    storeFingerprintForResuming: false,
    removeFingerprintOnSuccess: true,
  });

  // Why the last try of each upload stopped, by Uppy file id.
  const stopped = new Map<string, Exclude<SendResult, { ok: true }>["reason"]>();
  uppy.on("upload-error", (file, error, response) => {
    const original = (error as { originalResponse?: { getBody?: () => unknown; getStatus?: () => number } } | undefined)
      ?.originalResponse;
    const body = original?.getBody?.() ?? (response?.body as { xhr?: XMLHttpRequest } | undefined)?.xhr?.responseText;
    const status = original?.getStatus?.() ?? response?.status ?? 0;
    if (file) stopped.set(file.id, failureOf(status, body));
  });

  // Each file being sent: Uppy's id for it, and the service's upload id once
  // it has fully arrived (so trying again only repeats the hand-off).
  const sending = new Map<File, { fileId: string; uploadId?: string }>();
  let added = 0;

  /** The upload id once the whole file has arrived (and whether it just did), or why it stopped. */
  async function upload(
    file: File,
    onProgress: (p: number) => void,
  ): Promise<{ uploadId: string; resumed: boolean } | { stopped: Exclude<SendResult, { ok: true }>["reason"] }> {
    const known = sending.get(file);
    if (known?.uploadId) return { uploadId: known.uploadId, resumed: true };
    let entry = known;
    const progress = (f: { id: string } | undefined, p: { bytesUploaded: number; bytesTotal: number | null }) => {
      if (f && f.id === entry?.fileId && p.bytesTotal) onProgress(Math.floor((p.bytesUploaded / p.bytesTotal) * 100));
    };
    uppy.on("upload-progress", progress);
    try {
      let result;
      if (entry) {
        // Resumes from the last chunk the service confirmed.
        stopped.delete(entry.fileId);
        result = await uppy.retryUpload(entry.fileId);
      } else {
        const id = submissionId;
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
      if (!url) return { stopped: stopped.get(fileId) ?? "failed" };
      entry.uploadId = url.split("/").filter(Boolean).pop();
      return entry.uploadId ? { uploadId: entry.uploadId, resumed: false } : { stopped: "failed" };
    } catch {
      return { stopped: (entry && stopped.get(entry.fileId)) ?? "failed" };
    } finally {
      uppy.off("upload-progress", progress);
    }
  }

  return {
    finished: () => reportFinished(submissionId),
    async send(file, events, item) {
      const uploaded = await upload(file, events.onProgress);
      if ("stopped" in uploaded) return { ok: false, reason: uploaded.stopped };
      if (uploaded.resumed) {
        // Only the hand-off is tried again: Finishing up once the service answers.
        return handOver({ uploadId: uploaded.uploadId, item }, POLL_EVERY_MS, events.onFinishing);
      }
      events.onProgress(100);
      events.onFinishing();
      return handOver({ uploadId: uploaded.uploadId, item });
    },
  };
}

/**
 * Tells the service the page is done with this Submission (#61). Best-effort:
 * any answer, or none, is ignored; `keepalive` lets it go even as the tab
 * closes.
 */
export function reportFinished(submissionId: string): void {
  try {
    fetch(`${SUBMISSIONS_ENDPOINT}/${encodeURIComponent(submissionId)}/finished`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: "{}",
      keepalive: true,
    }).catch(() => {});
  } catch {
    // never the member's problem
  }
}

/**
 * Asks the service to hand an arrived file to ResourceSpace, and waits until
 * ResourceSpace has it. A big video takes minutes there, so the service may
 * answer 202 "finishing" at once; then the Item's status is polled (#55).
 * `onAnswered` is told when the service answers that it is on it.
 *
 * When the connection drops, it says so and stops: asking again (the page's
 * next try) is safe, since the service carries on with a hand-off already
 * under way and answers from its record once it is done (#58).
 */
export async function handOver(
  { uploadId, item }: { uploadId: string; item?: string },
  pollEveryMs = POLL_EVERY_MS,
  onAnswered?: () => void,
): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetch(ITEMS_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      // Only which upload and which Item: the answers are already the Submission's.
      body: JSON.stringify({ uploadId, item }),
    });
  } catch {
    return { ok: false, reason: "connection" };
  }
  if (res.status === 202) {
    onAnswered?.();
    return finished(uploadId, pollEveryMs);
  }
  if (res.ok) return { ok: true };
  return { ok: false, reason: failureOf(res.status, await res.text().catch(() => "")) };
}

/** Polls the Item's status until the hand-off is over. "failed" lets the member try again, which picks up where it stopped. */
async function finished(uploadId: string, pollEveryMs: number): Promise<SendResult> {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, pollEveryMs));
    let res: Response;
    let body: { status?: unknown; error?: unknown };
    try {
      res = await fetch(`${ITEMS_ENDPOINT}/${encodeURIComponent(uploadId)}`, { credentials: "same-origin" });
    } catch {
      return { ok: false, reason: "connection" };
    }
    if (res.status === 404) return { ok: false, reason: "failed" };
    if (!res.ok) return { ok: false, reason: failureOf(res.status, await res.text().catch(() => "")) };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      return { ok: false, reason: "connection" };
    }
    if (body.status === "finishing") continue;
    if (body.status === "sent") return { ok: true };
    if (body.status === "refused" && isRefusal(body.error)) return { ok: false, reason: body.error };
    // The service restarted before it began: asking again begins it.
    if (body.status === "arrived") return { ok: false, reason: "connection" };
    return { ok: false, reason: "failed" };
  }
}
