// ResourceSpace's API, as the least-privilege upload-service user (#24, #34).
//
// Request shape from the #13 research and the #34 live test (RS 11.0 r29660):
// the parameters go in the query string, signed as
// sha256(api key . query string) and appended as `&sign=`. The file itself is
// not signed: upload_multipart is a multipart POST with the file in the form
// field `file`, and the name sent becomes the Item's Original filename.
//
// Calls go straight over the Docker network (http://resourcespace) with the
// public Host header and X-Forwarded-Proto: https, so ResourceSpace answers as
// the public site (#17). RS_BASE_URL can point at the public address instead.
//
// Only three functions are used: create_resource (always with archive=-1,
// Pending Review), upload_multipart and update_field. The proxy never changes
// an Item's status (#34: the upload account could, through one core path).
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import type { Config } from "./config.ts";

/** Pending Review: Quarantine (ADR 0002). */
const PENDING_REVIEW = -1;

/** A ResourceSpace call that did not succeed. The message never includes the key or the signature. */
export class ResourceSpaceError extends Error {
  readonly fn: string;
  readonly status: number | undefined;
  constructor(fn: string, detail: string, status?: number) {
    super(`ResourceSpace ${fn} failed: ${detail}`);
    this.fn = fn;
    this.status = status;
  }
}

export interface ResourceSpace {
  /** Creates an empty Item in Pending Review; resolves with its ref. */
  createPendingItem(resourceType: number): Promise<number>;
  /** Uploads the file to the Item under `fileName`. */
  uploadFile(ref: number, filePath: string, fileName: string, contentType: string): Promise<void>;
  /** Writes one field, by shortname. */
  updateField(ref: number, field: string, value: string): Promise<void>;
}

/** A short, single-line piece of ResourceSpace's answer, for the operational log. */
function excerpt(body: string): string {
  return JSON.stringify(body.replace(/\s+/g, " ").slice(0, 200));
}

interface RawResponse {
  status: number;
  body: string;
}

export function createResourceSpace(config: Config): ResourceSpace {
  const base = new URL("/api/", config.rsBaseUrl);
  const client = base.protocol === "https:" ? https : http;

  function signedUrl(fn: string, params: Record<string, string | number>): URL {
    const query = new URLSearchParams({ user: config.rsUser, function: fn });
    for (const [k, v] of Object.entries(params)) query.append(k, String(v));
    const q = query.toString();
    const sign = createHash("sha256").update(config.rsApiKey + q).digest("hex");
    return new URL(`${base.pathname}?${q}&sign=${sign}`, base);
  }

  function request(
    fn: string,
    url: URL,
    method: "GET" | "POST",
    headers: Record<string, string | number> = {},
    write?: (req: http.ClientRequest) => void,
    timeoutMs = config.rsApiTimeoutMs,
  ): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      const req = client.request(url, {
        method,
        headers: {
          host: config.rsHostHeader,
          "x-forwarded-proto": "https",
          accept: "application/json",
          ...headers,
        },
        // How long the socket may sit idle: sending the file keeps it busy,
        // so for the upload this is the wait for ResourceSpace's previews.
        timeout: timeoutMs,
      });
      req.on("response", (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          if (body.length < 64 * 1024) body += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", (err) => reject(new ResourceSpaceError(fn, err.message)));
      });
      req.on("timeout", () => req.destroy(new Error("timed out")));
      req.on("error", (err) => reject(new ResourceSpaceError(fn, err.message)));
      if (write) write(req);
      else req.end();
    });
  }

  function json(fn: string, res: RawResponse): unknown {
    if (res.status !== 200) throw new ResourceSpaceError(fn, `status ${res.status}: ${excerpt(res.body)}`, res.status);
    try {
      return JSON.parse(res.body);
    } catch {
      throw new ResourceSpaceError(fn, "answer was not JSON", res.status);
    }
  }

  return {
    async createPendingItem(resourceType) {
      const fn = "create_resource";
      const res = await request(fn, signedUrl(fn, { resource_type: resourceType, archive: PENDING_REVIEW }), "GET");
      const ref = json(fn, res);
      // A bare `false` is how ResourceSpace says no (for example, missing e-1).
      if (typeof ref !== "number" || !Number.isInteger(ref) || ref < 1) {
        throw new ResourceSpaceError(fn, `unexpected answer ${JSON.stringify(ref).slice(0, 100)}`, res.status);
      }
      return ref;
    },

    async uploadFile(ref, filePath, fileName, contentType) {
      const fn = "upload_multipart";
      const boundary = `----sdfwa-upload-${randomBytes(12).toString("hex")}`;
      const head = Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
          `Content-Type: ${contentType}\r\n\r\n`,
      );
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
      const { size } = await stat(filePath);
      const res = await request(
        fn,
        // no_exif is sent empty, not 0: ResourceSpace reads the raw value, and
        // only an empty one takes the normal "extract embedded metadata" path
        // (so it keeps the date the photo was taken). With "0", RS 11.0 r29660
        // fails with a PHP warning (image_processing.php reads
        // $_REQUEST['file_name'], which only its own upload page sends);
        // found against a real instance while building #53.
        // autorotate: phones store pixels sideways plus an EXIF Orientation
        // tag, and RS only applies it (to JPEG, TIFF and PNG) when asked; its
        // own upload page asks by default. Without it, previews come out
        // rotated (#71).
        signedUrl(fn, { ref, no_exif: "", revert: 0, autorotate: 1 }),
        "POST",
        {
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "content-length": head.length + size + tail.length,
        },
        (req) => {
          req.write(head);
          const file = createReadStream(filePath);
          file.on("error", (err) => req.destroy(err));
          file.on("end", () => req.end(tail));
          file.pipe(req, { end: false });
        },
        // A 1 GB video goes over the Docker network in seconds; ResourceSpace
        // answers only after making its previews, which takes minutes (#55).
        config.rsUploadTimeoutMs,
      );
      // 204 is the only success; failures come back with other codes and a FAILED body.
      if (res.status !== 204) throw new ResourceSpaceError(fn, `status ${res.status}: ${excerpt(res.body)}`, res.status);
    },

    async updateField(ref, field, value) {
      const fn = "update_field";
      const res = await request(fn, signedUrl(fn, { resource: ref, field, value }), "GET");
      if (json(fn, res) !== true) throw new ResourceSpaceError(fn, `field ${field} was not saved`, res.status);
    },
  };
}
