// Seam 1's browser: drives the service the way the page does. A Submission is
// started with the Step 2 answers, each file goes up over tus (with
// tus-js-client, the library under Uppy's tus plugin), then the page asks for
// it to be handed to ResourceSpace. Plus small but real-looking files of each
// kind.
import * as tus from "tus-js-client";
import { COOKIE, signedInAs, type FakeUser, type Harness } from "./harness.ts";

/** The magic bytes of a type, then filler. */
function file(head: number[] | string, size: number, fill: number): Buffer {
  const b = Buffer.alloc(size, fill);
  if (typeof head === "string") b.write(head, 0, "latin1");
  else b.set(head);
  return b;
}

export const jpeg = (size = 300_000) => file([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00], size, 7);
export const png = (size = 20_000) => file([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], size, 1);
export const heic = (size = 50_000) => file("\x00\x00\x00\x18ftypheic", size, 3);
export const mp4 = (size = 80_000) => file("\x00\x00\x00\x20ftypisom", size, 5);
export const mov = (size = 80_000) => file("\x00\x00\x00\x14ftypqt  ", size, 6);

/** A paying member, as the auth service describes them. */
export function member(extra: Partial<FakeUser> = {}) {
  return signedInAs({
    claims: ["member"],
    id: "u-42",
    email: "pat@example.org",
    memberId: "M-1234",
    name: "Pat Member",
    ...extra,
  });
}

/** Step 2 filled in the way a member would: the required answers, nothing optional. */
export const ANSWERS = {
  title: "Dovetail class, May 3",
  programevent: "Classes & Workshops",
  subjecttype: ["Instruction / Class in Session"],
  date: "",
  location: "",
  eventname: "",
  caption: "",
};

/** What the page sends to start a Submission; `details` replaces some of the answers. */
export function startBody(opts: { details?: Record<string, unknown>; expectedItems?: number; rightsConfirmed?: boolean } = {}) {
  return {
    expectedItems: opts.expectedItems ?? 1,
    details: { ...ANSWERS, ...opts.details },
    rightsConfirmed: opts.rightsConfirmed ?? true,
  };
}

export interface UploadOptions {
  cookie?: string;
  /** The Submission to send into; a new one when not given. */
  submission?: string;
  /** Replaces the page's usual metadata (the Submission is still added unless given here). */
  metadata?: Record<string, string>;
  chunkSize?: number;
}

export function client(h: Harness) {
  /** Starts a Submission; resolves with the raw answer. */
  function begin(body: unknown = startBody(), cookie = COOKIE) {
    return fetch(`${h.url}/upload/api/submissions`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function startSubmission(cookie = COOKIE, body: unknown = startBody()): Promise<string> {
    const res = await begin(body, cookie);
    if (res.status !== 201) throw new Error(`starting a Submission answered ${res.status}: ${await res.text()}`);
    return ((await res.json()) as { submissionId: string }).submissionId;
  }

  /** Uploads over tus as the page does; resolves with the upload's id. */
  async function upload(data: Buffer, opts: UploadOptions = {}): Promise<string> {
    const submission = opts.submission ?? (await startSubmission(opts.cookie));
    return new Promise((resolve, reject) => {
      const u = new tus.Upload(data, {
        endpoint: `${h.url}/upload/api/files/`,
        headers: { cookie: opts.cookie ?? COOKIE },
        chunkSize: opts.chunkSize ?? 100_000,
        metadata: { submission, ...(opts.metadata ?? { filename: "IMG_4821.JPG", filetype: "image/jpeg" }) },
        retryDelays: [],
        storeFingerprintForResuming: false,
        onError: reject,
        onSuccess: () => resolve(u.url!.split("/").pop()!),
      });
      u.start();
    });
  }

  /** Asks for an arrived upload to be handed to ResourceSpace (`body` adds anything else to the request). */
  function finish(uploadId: string, body: Record<string, unknown> = {}, cookie = COOKIE) {
    return fetch(`${h.url}/upload/api/items`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ uploadId, ...body }),
    });
  }

  /** The live choices, as the page asks for them. */
  function options(cookie = COOKIE) {
    return fetch(`${h.url}/upload/api/options`, { headers: { cookie } });
  }

  /** Starts an upload of `size` bytes without sending any; resolves with the raw answer. */
  function create(submission: string, size: number, cookie = COOKIE) {
    return fetch(`${h.url}/upload/api/files/`, {
      method: "POST",
      headers: {
        cookie,
        "tus-resumable": "1.0.0",
        "upload-length": String(size),
        "upload-metadata": `submission ${Buffer.from(submission).toString("base64")}`,
      },
    });
  }

  return { begin, startSubmission, upload, finish, create, options };
}
