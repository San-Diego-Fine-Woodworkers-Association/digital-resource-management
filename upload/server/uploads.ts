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
//   - of the metadata the browser sends, only the device's file name is kept,
//     as the Item's Original Filename. Everything else is dropped.
import type http from "node:http";
import { Server } from "@tus/server";
import { FileStore } from "@tus/file-store";
import type { Upload } from "@tus/utils";
import type { Config } from "./config.ts";
import { originalFileName } from "./naming.ts";
import type { SessionUser } from "./session.ts";

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
  size: number | undefined;
  offset: number;
  path: string;
}

export interface Uploads {
  /** Handles a tus request from a signed-in, entitled member. */
  handle(req: http.IncomingMessage, res: http.ServerResponse, user: SessionUser): Promise<{ createdId?: string }>;
  /** The upload with this id if it exists and belongs to this member. */
  find(id: string, user: SessionUser): Promise<UploadInfo | undefined>;
  /** Deletes the staged bytes and tus's record of them. */
  remove(id: string): Promise<void>;
}

function toInfo(u: Upload): UploadInfo | undefined {
  const owner = u.metadata?.owner;
  if (!owner || !u.storage?.path) return undefined;
  return {
    id: u.id,
    owner,
    originalName: u.metadata?.filename ?? "",
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

export function createUploads(config: Config): Uploads {
  const store = new FileStore({ directory: config.stagingDir });
  const users = new WeakMap<http.IncomingMessage, SessionUser>();
  const created = new WeakMap<http.IncomingMessage, string>();
  const publicOrigin = new URL(config.publicBaseUrl).origin;

  const tus = new Server({
    path: FILES_PATH,
    datastore: store,
    maxSize: config.photoMaxBytes,
    relativeLocation: true,
    respectForwardedHeaders: false,
    allowedOrigins: [publicOrigin],
    async onUploadCreate(req, upload) {
      const node = nodeRequest(req);
      const user = node && users.get(node);
      // Cannot happen (app.ts always sets it); refuse rather than store an orphan.
      if (!node || !user) throw { status_code: 500, body: "internal\n" };
      created.set(node, upload.id);
      const name = upload.metadata?.filename ?? upload.metadata?.name;
      return { metadata: { owner: user.id, filename: originalFileName(name) } };
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
      if (rest !== "") {
        // HEAD, PATCH or DELETE of one upload: only its owner may.
        const id = rest.replace(/\/$/, "");
        if (!(await find(id, user))) {
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Tus-Resumable": "1.0.0", Connection: "close" });
          res.end("Not found\n");
          return {};
        }
      }
      users.set(req, user);
      await tus.handle(req, res);
      return { createdId: res.statusCode === 201 ? created.get(req) : undefined };
    },
    find,
    async remove(id) {
      if (!isUploadId(id)) return;
      try {
        await store.remove(id);
      } catch {
        // already gone
      }
    },
  };
}
