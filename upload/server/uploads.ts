// The chunked upload endpoint: tus at /upload/api/files (ADR 0001, #20),
// served by @tus/server with its file store on the staging volume.
//
// The caller (app.ts) has already checked the session, the kill switch and
// the member's entitlement before any of this runs, so no byte is written for
// someone who is not allowed to send. Here:
//   - upload ids are made by the server (32 hex characters); the name the
//     browser gives a file is never used on disk;
//   - each upload belongs to the member who created it, and nobody else can
//     see it, add to it or hand it over;
//   - each upload goes into one of the member's Submissions, and is refused
//     when that Submission has no room for it (submissions.ts);
//   - of the metadata the browser sends, only the device's file name is kept,
//     as the Item's Original Filename, and the Submission it names, once
//     checked. Everything else is dropped;
//   - the member's quotas (quotas.ts) are checked when an upload starts and
//     before each chunk, and so is the room on the staging volume
//     (staging.ts): at the cap, or without the space free, the answer is
//     "busy" and nothing is written.
import type http from "node:http";
import { Server } from "@tus/server";
import { FileStore } from "@tus/file-store";
import type { Upload } from "@tus/utils";
import type { Refusal } from "../shared/media.ts";
import type { Config } from "./config.ts";
import { originalFileName } from "./naming.ts";
import type { Quotas } from "./quotas.ts";
import type { SessionUser } from "./session.ts";
import type { Staging } from "./staging.ts";
import type { Submissions } from "./submissions.ts";

export const FILES_PATH = "/upload/api/files";

const UPLOAD_ID = /^[0-9a-f]{32}$/;

export function isUploadId(id: string): boolean {
  return UPLOAD_ID.test(id);
}

/** What the service records with each upload, beside the bytes. */
export interface UploadInfo {
  id: string;
  /** The session user id of the member who created it. */
  owner: string;
  /** The name on the member's device, cleaned (for Submitter Original Filename only). */
  originalName: string;
  /** The Submission it belongs to, checked when it was created. */
  submissionId: string;
  /** Its number within the Submission, from 1, for the File name. */
  itemNumber: number;
  size: number | undefined;
  offset: number;
  path: string;
}

export interface Uploads {
  /** Handles a tus request from a signed-in, entitled member. */
  handle(req: http.IncomingMessage, res: http.ServerResponse, user: SessionUser): Promise<{ createdId?: string; refusal?: string }>;
  /** The upload with this id if it exists and belongs to this member. */
  find(id: string, user: SessionUser): Promise<UploadInfo | undefined>;
  /**
   * Deletes the staged bytes and tus's record of them. `sent` when the Item
   * reached ResourceSpace: it then counts towards the member's day; otherwise
   * its place in the day is given back.
   */
  remove(id: string, outcome?: { sent: boolean }): Promise<void>;
}

/** How each refusal is answered, here and on the hand-off (app.ts). */
export const REFUSAL_STATUS: Record<Refusal, number> = {
  wrong_type: 415,
  too_big: 413,
  too_much_in_all: 413,
  too_many: 422,
  too_many_videos: 422,
  too_many_today: 429,
  too_much_today: 429,
};

/** When a busy staging volume is worth trying again: files leave it as they are handed over. */
const BUSY_RETRY_S = 120;

function toInfo(u: Upload): UploadInfo | undefined {
  const owner = u.metadata?.owner;
  const submissionId = u.metadata?.submission;
  const itemNumber = Number(u.metadata?.item);
  if (!owner || !submissionId || !Number.isInteger(itemNumber) || itemNumber < 1 || !u.storage?.path) return undefined;
  return {
    id: u.id,
    owner,
    originalName: u.metadata?.filename ?? "",
    submissionId,
    itemNumber,
    size: u.size,
    offset: u.offset,
    path: u.storage.path,
  };
}

/** The node request behind a tus (srvx) request. */
function nodeRequest(req: unknown): http.IncomingMessage | undefined {
  const r = req as { runtime?: { node?: { req?: http.IncomingMessage } } };
  return r.runtime?.node?.req;
}

/** A tus refusal: thrown from a hook, answered with this status and a JSON body like the rest of the API. */
function refuse(status: number, error: string) {
  return { status_code: status, body: JSON.stringify({ error }) };
}

function sendError(res: http.ServerResponse, status: number, error: string, retryAfterS?: number) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Tus-Resumable": "1.0.0",
    "Cache-Control": "no-store",
    Connection: "close",
    ...(retryAfterS ? { "Retry-After": String(retryAfterS) } : {}),
  });
  res.end(JSON.stringify({ error }));
}

export function createUploads(
  config: Config,
  submissions: Submissions,
  deps: {
    staging: Staging;
    quotas: Quotas;
    /** Something arrived for this Submission (an upload made, or a chunk): its Reviewers' email waits longer (#61). */
    onProgress?: (submissionId: string) => void;
  },
): Uploads {
  const { staging, quotas } = deps;
  const store = new FileStore({ directory: config.stagingDir });
  const users = new WeakMap<http.IncomingMessage, SessionUser>();
  const responses = new WeakMap<http.IncomingMessage, http.ServerResponse>();
  const created = new WeakMap<http.IncomingMessage, string>();
  /** Why a request was refused, for its audit line. */
  const refusals = new WeakMap<http.IncomingMessage, string>();
  const publicOrigin = new URL(config.publicBaseUrl).origin;
  const { limits } = config;

  /** A refusal from a tus hook. */
  function no(node: http.IncomingMessage, status: number, error: string) {
    refusals.set(node, error);
    return refuse(status, error);
  }

  /** A refusal before tus sees the request. */
  function answer(res: http.ServerResponse, status: number, error: string, retryAfterS?: number) {
    sendError(res, status, error, retryAfterS);
    return { refusal: error };
  }

  const tus = new Server({
    path: FILES_PATH,
    datastore: store,
    // The largest file of any kind. Whether it is a photo (and so must be
    // much smaller) is only known from its content, at the hand-off.
    maxSize: limits.videoMaxBytes,
    relativeLocation: true,
    respectForwardedHeaders: false,
    allowedOrigins: [publicOrigin],
    async onUploadCreate(req, upload) {
      const node = nodeRequest(req);
      const user = node && users.get(node);
      // Cannot happen (app.ts always sets it); refuse rather than store an orphan.
      if (!node || !user) throw { status_code: 500, body: "internal\n" };
      // The size must be known up front: the Submission's room is reserved from it.
      if (upload.size === undefined) throw no(node, 400, "invalid");
      const submissionId = upload.metadata?.submission ?? "";
      const room = submissions.reserve(submissionId, user, upload.id, upload.size);
      if ("unknown" in room) throw no(node, 404, "not_found");
      if ("refusal" in room) throw no(node, REFUSAL_STATUS[room.refusal], room.refusal);
      // The member's day and what they have on staging: counted from here on if it fits.
      const quota = quotas.start(user.id, upload.id, upload.size);
      if ("refusal" in quota) {
        submissions.release(submissionId, upload.id);
        responses.get(node)?.setHeader("Retry-After", String(quota.retryAfterS));
        throw no(node, 429, quota.refusal);
      }
      created.set(node, upload.id);
      deps.onProgress?.(submissionId);
      const name = upload.metadata?.filename ?? upload.metadata?.name;
      return {
        metadata: { owner: user.id, filename: originalFileName(name), submission: submissionId, item: String(room.itemNumber) },
      };
    },
  });

  async function find(id: string, user: SessionUser): Promise<UploadInfo | undefined> {
    if (!isUploadId(id)) return undefined;
    let upload: Upload;
    try {
      upload = await store.getUpload(id);
    } catch {
      return undefined;
    }
    const info = toInfo(upload);
    return info && info.owner === user.id ? info : undefined;
  }

  return {
    async handle(req, res, user) {
      const url = new URL(req.url ?? "/", "http://upload.internal");
      const rest = url.pathname.slice(FILES_PATH.length).replace(/^\//, "");
      // @tus/server would stream a staged file back on GET. Nothing needs
      // that, and serving untrusted bytes from this origin is a risk.
      if (req.method === "GET") {
        res.writeHead(405, { Allow: "POST, HEAD, PATCH, DELETE, OPTIONS", "Content-Type": "text/plain; charset=utf-8" });
        res.end("Method not allowed\n");
        return {};
      }
      // Bigger than any file we take: say so in the API's own words (tus
      // would refuse it too, in its own).
      if (req.method === "POST" && Number(req.headers["upload-length"]) > limits.videoMaxBytes) {
        return answer(res, 413, "too_big");
      }
      if (req.method === "POST") {
        // Bytes only ever come in a PATCH, where each chunk is checked; tus's
        // "creation with upload" (a POST carrying this type) would slip the
        // first one past that. The page never uses it.
        if ((req.headers["content-type"] ?? "").toLowerCase().includes("offset+octet-stream")) {
          return answer(res, 400, "invalid");
        }
        // A new Item at the staging cap: busy.
        if (!(await staging.room(0))) {
          return answer(res, 503, "busy", BUSY_RETRY_S);
        }
      }
      let mine: UploadInfo | undefined;
      if (rest !== "") {
        // HEAD, PATCH or DELETE of one upload: only its owner may.
        const id = rest.replace(/\/$/, "");
        mine = await find(id, user);
        if (!mine) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Tus-Resumable": "1.0.0", Connection: "close" });
          res.end("Not found\n");
          return {};
        }
      }
      let writing: { done: () => void } | undefined;
      if (req.method === "PATCH" && mine) {
        // Before a byte of the chunk is written: does it fit on the volume,
        // and in what the member may have going?
        const remaining = Math.max(0, (mine.size ?? 0) - mine.offset);
        const declared = Number(req.headers["content-length"]);
        const incoming = Number.isFinite(declared) && declared >= 0 ? Math.min(declared, remaining) : remaining;
        if (!(await staging.room(incoming))) {
          return answer(res, 503, "busy", BUSY_RETRY_S);
        }
        const slot = quotas.write(user.id, mine.id, incoming);
        if ("refusal" in slot) {
          return answer(res, 429, slot.refusal, slot.retryAfterS);
        }
        writing = slot;
        // A chunk is arriving: the Reviewers' email waits for the rest (#61).
        deps.onProgress?.(mine.submissionId);
      }
      users.set(req, user);
      responses.set(req, res);
      try {
        await tus.handle(req, res);
      } finally {
        writing?.done();
      }
      if (req.method === "PATCH" && mine) {
        const after = await find(mine.id, user);
        if (after) quotas.progress(after.id, after.offset);
      }
      // The member took it out before it was handed over: free its room.
      if (req.method === "DELETE" && mine && res.statusCode === 204) {
        submissions.release(mine.submissionId, mine.id);
        quotas.removed(mine.id);
      }
      return { createdId: res.statusCode === 201 ? created.get(req) : undefined, refusal: refusals.get(req) };
    },
    find,
    async remove(id, outcome) {
      if (!isUploadId(id)) return;
      if (outcome?.sent) quotas.sent(id);
      try {
        await store.remove(id);
      } catch {
        // already gone
      }
      quotas.removed(id);
    },
  };
}
