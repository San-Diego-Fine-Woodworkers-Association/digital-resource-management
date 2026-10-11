// A fake ResourceSpace API for seam 1, modelled on what the #13 research and
// the #34 live permission test found on ResourceSpace 11.0 (r29660):
//
//  - GET/POST /api/?user=<name>&function=<fn>&<params>&sign=<sha256(key . query)>
//    A bad signature answers 401 "Invalid signature".
//  - create_resource(resource_type, archive): the integer ref, or bare `false`
//    for an archive state the upload-service user may not use (anything but -1).
//  - upload_multipart(ref, no_exif, revert): a multipart POST with the file in
//    the form field `file`; 204 on success. The file name sent becomes the
//    Item's Original filename.
//  - update_field(resource, field, value): `true`, or `false` for a field the
//    user may not write (here: anything but the proxy's 13 shortnames).
import { createHash } from "node:crypto";
import type { FakeReply, SeenRequest } from "./harness.ts";

export const FAKE_RS_USER = "upload-service";
export const FAKE_RS_KEY = "test-uploader-key-0123456789abcdef";

/** The 13 fields the Member Upload Service group may write (#34). */
const WRITABLE_FIELDS = new Set([
  "title",
  "programevent",
  "subjecttype",
  "date",
  "location",
  "eventname",
  "caption",
  "submittername",
  "submitteremail",
  "submittermemberid",
  "submissionid",
  "submitterrights",
  "submitterfilename",
]);

export interface FakeResource {
  ref: number;
  resourceType: number;
  /** -1 is Pending Review (Quarantine); 0 is Active. */
  archive: number;
  file?: { name: string; contentType: string; data: Buffer };
  fields: Record<string, string>;
}

export interface ApiCall {
  fn: string;
  params: URLSearchParams;
  headers: SeenRequest["headers"];
}

export interface FakeResourceSpace {
  resources: Map<number, FakeResource>;
  calls: ApiCall[];
  /** Make a call fail: return a reply to send instead, or undefined to go ahead. */
  failWhen: (call: ApiCall) => FakeReply | undefined;
  /** For the harness: answers a request to /api/. */
  handle: (req: SeenRequest) => FakeReply;
}

function sign(key: string, query: string) {
  return createHash("sha256").update(key + query).digest("hex");
}

/** The parts of a multipart/form-data body, enough for one file field. */
export function parseMultipart(contentType: string, body: Buffer) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  const b = boundary?.[1] ?? boundary?.[2];
  if (!b) return [];
  const delimiter = Buffer.from(`--${b}`);
  const parts: { name: string; filename?: string; contentType?: string; data: Buffer }[] = [];
  let pos = body.indexOf(delimiter);
  while (pos !== -1) {
    const start = pos + delimiter.length;
    if (body.subarray(start, start + 2).toString() === "--") break;
    const next = body.indexOf(delimiter, start);
    if (next === -1) break;
    const part = body.subarray(start + 2, next - 2); // drop the CRLF after the delimiter and before the next
    const headerEnd = part.indexOf("\r\n\r\n");
    const head = part.subarray(0, headerEnd).toString("utf8");
    const data = part.subarray(headerEnd + 4);
    const name = /name="([^"]*)"/.exec(head)?.[1] ?? "";
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    const ct = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1];
    parts.push({ name, filename, contentType: ct, data });
    pos = next;
  }
  return parts;
}

export function createFakeResourceSpace(): FakeResourceSpace {
  let nextRef = 1000;
  const rs: FakeResourceSpace = {
    resources: new Map(),
    calls: [],
    failWhen: () => undefined,
    handle(req) {
      const raw = req.url.slice(req.url.indexOf("?") + 1);
      const params = new URLSearchParams(raw);
      const signed = raw.replace(/&sign=[^&]*$/, "");
      if (params.get("user") !== FAKE_RS_USER || params.get("sign") !== sign(FAKE_RS_KEY, signed)) {
        return { status: 401, body: "Invalid signature" };
      }
      const call: ApiCall = { fn: params.get("function") ?? "", params, headers: req.headers };
      rs.calls.push(call);
      const failure = rs.failWhen(call);
      if (failure) return failure;

      switch (call.fn) {
        case "create_resource": {
          const archive = Number(params.get("archive") ?? "999");
          // Only Pending Review is open to the uploader (it lacks e0 and e-2).
          if (archive !== -1) return { json: false };
          const ref = nextRef++;
          rs.resources.set(ref, { ref, resourceType: Number(params.get("resource_type")), archive, fields: {} });
          return { json: ref };
        }
        case "upload_multipart": {
          const resource = rs.resources.get(Number(params.get("ref")));
          if (req.method !== "POST") return { status: 405, json: { error: "POST only" } };
          if (!resource) return { json: { status: "FAILED", data: { message: "Permission denied" } } };
          if (params.get("no_exif") === null || params.get("revert") === null) return { status: 400, json: false };
          // Seen on a real RS 11.0 (r29660): with metadata extraction asked for
          // as no_exif=0 it trips over a missing `file_name` request value.
          if (params.get("no_exif") === "0") {
            return { status: 400, json: { error: true, error_note: "Sorry, an error has occurred. " } };
          }
          const file = parseMultipart(String(req.headers["content-type"] ?? ""), req.body).find((p) => p.name === "file");
          if (!file?.filename) return { status: 400, json: { status: "FAILED" } };
          resource.file = { name: file.filename, contentType: file.contentType ?? "", data: file.data };
          return { status: 204, body: "" };
        }
        case "update_field": {
          const resource = rs.resources.get(Number(params.get("resource")));
          const field = params.get("field") ?? "";
          if (!resource || !WRITABLE_FIELDS.has(field)) return { json: false };
          resource.fields[field] = params.get("value") ?? "";
          return { json: true };
        }
        default:
          return { json: false };
      }
    },
  };
  return rs;
}
