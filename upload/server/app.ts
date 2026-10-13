// The upload service's HTTP surface, everything under /upload:
//
//   /upload, /upload/...   the page, gated on the SDFWA session
//   /upload/assets/...     the built app's scripts and styles (public)
//   /upload/api/...        the narrow API; session re-checked on every call
//     GET /options         the live choices for the list fields (options.ts)
//     POST /submissions    start a Submission with the Step 2 answers and any Item's own (Step 3): its id goes on every upload (submissions.ts)
//     /files, /files/<id>  tus: each photo or video arrives in chunks (uploads.ts)
//     POST /items          hand an arrived one to ResourceSpace (items.ts)
//     GET /items/<id>      where that hand-off has got to; the page polls it
//     GET /session         who is signed in
//   /upload/health         staging usage and ResourceSpace reachability
//
// Traefik routes only /upload here; ResourceSpace keeps everything else.
import http from "node:http";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { BOOT_ELEMENT_ID, type Boot } from "../shared/boot.ts";
import { createAuditLog, stdoutSink, type AuditEvent, type AuditSink } from "./audit.ts";
import type { Config } from "./config.ts";
import { checkHealth } from "./health.ts";
import { checkDetails, checkItems, type Options } from "../shared/details.ts";
import { createItems, type HandOffRequest, type HandOffResult } from "./items.ts";
import { rightsRecord } from "./naming.ts";
import { createLiveOptions } from "./options.ts";
import { createResourceSpace } from "./resourcespace.ts";
import { checkSession, displayName, isEntitled, type Session, type SessionUser } from "./session.ts";
import { createSubmissions } from "./submissions.ts";
import { createUploads, FILES_PATH, REFUSAL_STATUS } from "./uploads.ts";

export interface ServiceOptions {
  auditSink?: AuditSink;
  /** Operational messages (not the audit trail). */
  log?: (message: string, fields?: Record<string, unknown>) => void;
  /** The pause before the first read-back retry (items.ts); tests shorten it. */
  readBackRetryDelayMs?: number;
}

const BASE = "/upload";

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** A hand-off is an id or two; anything much bigger is not one. */
const MAX_JSON_BODY = 16 * 1024;
/**
 * A Submission's answers: a few KB for Step 2 (a 2000-character Caption),
 * plus up to 50 Items' own from Step 3 (#57), each at most the same again.
 */
const MAX_SUBMISSION_BODY = 256 * 1024;

class BodyError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`body ${status}`);
    this.status = status;
  }
}

async function readJson(req: http.IncomingMessage, max = MAX_JSON_BODY): Promise<unknown> {
  const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  // Also keeps other sites out: a cross-site form cannot send application/json.
  if (type !== "application/json") throw new BodyError(415);
  const declared = Number(req.headers["content-length"] ?? "0");
  if (declared > max) throw new BodyError(413);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new BodyError(413);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BodyError(400);
  }
}

/**
 * Only which upload, and the page's name for its Item (#57); the answers come
 * from its Submission's record. Anything else the page sends is ignored.
 */
function parseHandOff(body: unknown): HandOffRequest | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "invalid" };
  const b = body as Record<string, unknown>;
  if (typeof b.uploadId !== "string") return { error: "invalid" };
  return typeof b.item === "string" ? { uploadId: b.uploadId, item: b.item.slice(0, 64) } : { uploadId: b.uploadId };
}

/** The promise's value if it settles within `ms`, otherwise undefined (it carries on). */
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function securityHeaders(res: http.ServerResponse) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", CSP);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function notFound(res: http.ServerResponse) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end("Not found");
}

/**
 * JSON that is safe inside a <script type="application/json"> element: no
 * `</script>` or comment openers can appear. The block is parsed with
 * JSON.parse, never executed, so line separators need no escaping.
 */
function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

export function createService(config: Config, options: ServiceOptions = {}): http.Server {
  const audit = createAuditLog(options.auditSink ?? stdoutSink);
  const rsConfigured = config.rsApiKey !== "";
  const log =
    options.log ??
    ((message: string, fields: Record<string, unknown> = {}) =>
      process.stderr.write(JSON.stringify({ time: new Date().toISOString(), message, ...fields }) + "\n"));
  const rs = createResourceSpace(config);
  const liveOptions = createLiveOptions(rs);
  const submissions = createSubmissions(config.limits, { dir: config.stagingDir });
  const uploads = createUploads(config, submissions);
  const items = createItems(config, {
    uploads,
    submissions,
    rs,
    options: liveOptions,
    log,
    retryDelayMs: options.readBackRetryDelayMs,
  });

  const webRoot = path.resolve(config.webRoot);
  const indexHtml = readFileSync(path.join(webRoot, "index.html"), "utf8");
  if (!indexHtml.includes("</head>")) throw new Error("index.html has no </head> to put the boot data before");

  const uploadUrl = `${config.publicBaseUrl}${BASE}/`;
  const signOutUrl = `${config.authBaseUrl}/logout?redirect=${encodeURIComponent(uploadUrl)}`;
  const signInUrl = (target: string) => `${config.authBaseUrl}/login?redirect=${encodeURIComponent(target)}`;
  const authOpts = { authBaseUrl: config.authBaseUrl, timeoutMs: config.authTimeoutMs };

  async function session(req: http.IncomingMessage): Promise<Session> {
    const result = await checkSession(req.headers.cookie, authOpts);
    if (result.kind === "unavailable") log("auth service unavailable", { reason: result.reason });
    return result;
  }

  async function shellUser(req: http.IncomingMessage, user: SessionUser) {
    return { name: await displayName(req.headers.cookie ?? "", user, authOpts), email: user.email };
  }

  function sendPage(res: http.ServerResponse, status: number, boot: Boot, headers: Record<string, string> = {}) {
    const tag = `<script type="application/json" id="${BOOT_ELEMENT_ID}">${scriptSafeJson(boot)}</script>`;
    const html = indexHtml.replace("</head>", `${tag}</head>`);
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      Vary: "Cookie",
      ...headers,
    });
    res.end(html);
  }

  // --- the page ------------------------------------------------------------

  async function page(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" });
      return res.end();
    }
    if (config.uploadsPaused) return sendPage(res, 503, { screen: "paused" }, { "Retry-After": "300" });

    const s = await session(req);
    if (s.kind === "unavailable") return sendPage(res, 503, { screen: "unavailable" }, { "Retry-After": "30" });
    if (s.kind === "signed-out") {
      res.writeHead(302, {
        Location: signInUrl(`${config.publicBaseUrl}${url.pathname}${url.search}`),
        "Cache-Control": "no-store",
      });
      return res.end();
    }
    const user = await shellUser(req, s.user);
    if (!isEntitled(s.user)) {
      return sendPage(res, 403, { screen: "not-member", user, renewUrl: config.renewUrl, signOutUrl });
    }
    // Without its ResourceSpace key the service cannot take anything: say so
    // plainly rather than let a member pick photos that cannot be sent.
    if (!rsConfigured) return sendPage(res, 503, { screen: "unavailable" }, { "Retry-After": "300" });
    return sendPage(res, 200, { screen: "app", user, signOutUrl });
  }

  // --- the API -------------------------------------------------------------

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const method = req.method ?? "GET";
    const isWrite = !READ_METHODS.has(method);
    // Nothing here reads the request body: every refusal is decided from the
    // headers alone. When a write is refused, the connection is closed rather
    // than draining a body we will never use.
    const record = (outcome: string, user?: SessionUser, extra: Partial<AuditEvent> = {}) => {
      const forwarded = req.headers["x-forwarded-for"];
      audit.record({
        event: "upload_request",
        outcome,
        method,
        path: url.pathname,
        user,
        ip: (typeof forwarded === "string" ? forwarded.slice(0, 200) : undefined) ?? req.socket.remoteAddress,
        ...extra,
      });
    };
    const answer = (
      status: number,
      body: unknown,
      outcome: string,
      user?: SessionUser,
      headers: Record<string, string> = {},
      extra: Partial<AuditEvent> = {},
    ) => {
      if (isWrite) {
        record(outcome, user, extra);
        if (status >= 400) headers = { ...headers, Connection: "close" };
      }
      sendJson(res, status, body, headers);
    };

    if (isWrite && config.uploadsPaused) return answer(503, { error: "paused" }, "paused", undefined, { "Retry-After": "300" });

    const s = await session(req);
    if (s.kind === "unavailable") {
      return answer(503, { error: "auth_unavailable" }, "auth_unavailable", undefined, { "Retry-After": "30" });
    }
    if (s.kind === "signed-out") {
      return answer(401, { error: "signed_out", signInUrl: signInUrl(uploadUrl) }, "signed_out");
    }
    if (!isEntitled(s.user)) {
      return answer(403, { error: "not_member", renewUrl: config.renewUrl, signOutUrl }, "not_member", s.user);
    }

    const route = url.pathname.slice(`${BASE}/api`.length);
    if (route === "/session" && (method === "GET" || method === "HEAD")) {
      return answer(200, { user: await shellUser(req, s.user) }, "ok", s.user);
    }

    const isFiles = url.pathname === FILES_PATH || url.pathname.startsWith(`${FILES_PATH}/`);
    const isItems = route === "/items";
    const isSubmissions = route === "/submissions";
    const isOptions = route === "/options";
    if (route.startsWith("/items/") && (method === "GET" || method === "HEAD")) {
      const status = await items.status(route.slice("/items/".length), s.user);
      if (status.status === "not_found") return answer(404, { error: "not_found" }, "not_found", s.user);
      const body = status.status === "refused" ? { status: "refused", error: status.refusal } : status;
      return answer(200, body, "ok", s.user);
    }
    if ((isFiles || isItems || isSubmissions || isOptions) && !rsConfigured) {
      log("refusing uploads: RS_UPLOADER_API_KEY is not set");
      return answer(503, { error: "unavailable" }, "not_configured", s.user, { "Retry-After": "300" });
    }
    if (isFiles) {
      const { createdId } = await uploads.handle(req, res, s.user);
      // One audit line when an upload starts, not one per chunk.
      if (method === "POST") {
        record(createdId ? "created" : `refused_${res.statusCode}`, s.user, { uploadId: createdId });
      }
      return;
    }
    if (isItems && method === "POST") return handOff(req, s.user, answer, record);
    if (isSubmissions && method === "POST") return startSubmission(req, s.user, answer);
    if (isOptions && (method === "GET" || method === "HEAD")) return sendOptions(answer, s.user);
    return answer(404, { error: "not_found" }, "not_found", s.user);
  }

  type Answer = (
    status: number,
    body: unknown,
    outcome: string,
    user?: SessionUser,
    headers?: Record<string, string>,
    extra?: Partial<AuditEvent>,
  ) => void;

  async function sendOptions(answer: Answer, user: SessionUser) {
    try {
      return answer(200, { options: await liveOptions.get() }, "ok", user);
    } catch (err) {
      log("could not read the choices from ResourceSpace", { error: err instanceof Error ? err.message : String(err) });
      return answer(503, { error: "unavailable" }, "unavailable", user, { "Retry-After": "30" });
    }
  }

  /**
   * Starts a Submission from the Step 2 answers and each changed Item's own
   * (#57), checked here because ResourceSpace's API does not (ADR 0003): the
   * required fields, and each choice against the live options. JSON only, so
   * other sites cannot start one.
   */
  async function startSubmission(req: http.IncomingMessage, user: SessionUser, answer: Answer) {
    let body: Record<string, unknown>;
    try {
      const raw = await readJson(req, MAX_SUBMISSION_BODY);
      if (typeof raw !== "object" || raw === null) throw new BodyError(400);
      body = raw as Record<string, unknown>;
    } catch (err) {
      const status = err instanceof BodyError ? err.status : 400;
      return answer(status, { error: "invalid" }, "invalid", user);
    }
    const expectedItems = body.expectedItems;
    if (typeof expectedItems !== "number" || !Number.isInteger(expectedItems) || expectedItems < 1 || expectedItems > config.limits.maxItems) {
      return answer(400, { error: "invalid" }, "invalid", user);
    }
    if (body.rightsConfirmed !== true) return answer(422, { error: "rights_required" }, "rights_required", user);

    // Step 2's answers first; each Item's own are checked on top of them.
    const check = (options: Options) => {
      const details = checkDetails(body.details, options);
      if ("problems" in details) return details;
      const items = checkItems(body.items, details.details, options, expectedItems);
      return "items" in items ? { ...details, ...items } : items;
    };
    let checked;
    try {
      checked = check(await liveOptions.get());
      // A choice not in the cached list may have just been added: look again before refusing it.
      if ("problems" in checked && checked.problems.some((p) => p.problem === "not_offered")) {
        checked = check(await liveOptions.get(0));
      }
    } catch (err) {
      log("could not read the choices from ResourceSpace", { error: err instanceof Error ? err.message : String(err) });
      return answer(503, { error: "unavailable" }, "unavailable", user, { "Retry-After": "30" });
    }
    if ("invalid" in checked) return answer(400, { error: "invalid" }, "invalid", user);
    if ("problems" in checked) {
      // With the choices as they are now, so the page can offer them again.
      // A problem with one Item's own answer names the Item.
      return answer(422, { error: "invalid_details", problems: checked.problems, options: await liveOptions.get() }, "invalid_details", user);
    }

    const record = await submissions.create(user, {
      expectedItems,
      details: checked.details,
      ...(Object.keys(checked.items).length > 0 ? { items: checked.items } : {}),
      rights: rightsRecord(new Date()),
    });
    const submissionId = record.submissionId;
    return answer(201, { submissionId }, "submission_started", user, {}, { submissionId });
  }

  type RecordAudit = (outcome: string, user?: SessionUser, extra?: Partial<AuditEvent>) => void;

  async function handOff(req: http.IncomingMessage, user: SessionUser, answer: Answer, record: RecordAudit) {
    let body: unknown;
    try {
      body = await readJson(req);
    } catch (err) {
      const status = err instanceof BodyError ? err.status : 400;
      return answer(status, { error: "invalid" }, "invalid", user);
    }
    const parsed = parseHandOff(body);
    if ("error" in parsed) return answer(parsed.error === "invalid" ? 400 : 422, { error: parsed.error }, parsed.error, user);

    const name = await displayName(req.headers.cookie ?? "", user, authOpts);
    const uploadId = parsed.uploadId.slice(0, 64);
    const pending = items.handOff(parsed, { user, name });
    // A big video keeps ResourceSpace busy for minutes, longer than a phone
    // should hold a request open (#55). Past a short wait the page is told
    // "finishing" and polls GET /items/<id>; the hand-off carries on here
    // and its outcome still gets its audit line.
    const result = await within(pending, config.handOffWaitMs);
    if (result) {
      const [status, body, outcome, extra] = handOffAnswer(result, uploadId);
      return answer(status, body, outcome, user, {}, extra);
    }
    answer(202, { status: "finishing" }, "finishing", user, {}, { uploadId });
    pending.then(
      (late) => {
        const [, , outcome, extra] = handOffAnswer(late, uploadId);
        record(outcome, user, extra);
      },
      (err: unknown) => log("hand-off failed", { uploadId, error: err instanceof Error ? err.message : String(err) }),
    );
  }

  /** How a hand-off's result is answered and audited. */
  function handOffAnswer(result: HandOffResult, uploadId: string): [number, unknown, string, Partial<AuditEvent>] {
    switch (result.outcome) {
      case "sent": {
        const r = result.record;
        return [200, { status: "sent" }, "sent", {
          uploadId,
          submissionId: r.submissionId,
          sizeBytes: r.sizeBytes,
          detectedType: r.detectedType,
        }];
      }
      case "not_found":
        return [404, { error: "not_found" }, "not_found", { uploadId }];
      case "incomplete":
        return [409, { error: "incomplete" }, "incomplete", { uploadId }];
      case "refused":
        return [REFUSAL_STATUS[result.refusal], { error: result.refusal }, result.refusal, {
          uploadId,
          sizeBytes: result.sizeBytes,
          detectedType: result.detectedType,
        }];
      case "not_saved":
        log("could not save to ResourceSpace", { uploadId, ref: result.record?.ref, error: result.error });
        return [502, { error: "not_saved" }, "not_saved", {
          uploadId,
          submissionId: result.record?.submissionId,
          sizeBytes: result.record?.sizeBytes,
          detectedType: result.record?.detectedType,
        }];
    }
  }

  // --- static files ----------------------------------------------------------

  /** Serves a built file if there is one; false if not. */
  async function staticFile(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname.slice(BASE.length));
    } catch {
      return false;
    }
    if (rel.includes("\0") || rel === "/" || rel === "" || rel === "/index.html") return false;
    const file = path.resolve(webRoot, "." + rel);
    if (!file.startsWith(webRoot + path.sep)) return false;
    try {
      if (!(await stat(file)).isFile()) return false;
    } catch {
      return false;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
      "Cache-Control": rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
    });
    res.end(body);
    return true;
  }

  // --- routing ---------------------------------------------------------------

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    securityHeaders(res);
    const raw = req.url ?? "/";
    if (!raw.startsWith("/") || raw.startsWith("//")) return notFound(res);
    const url = new URL(raw, "http://upload.internal");
    const p = url.pathname;

    if (p !== BASE && !p.startsWith(`${BASE}/`)) return notFound(res);
    if (p === `${BASE}/health`) {
      const health = await checkHealth(config, rsConfigured);
      return sendJson(res, health.status === "ok" ? 200 : 503, health);
    }
    if (p === `${BASE}/api` || p.startsWith(`${BASE}/api/`)) return api(req, res, url);
    if (p.startsWith(`${BASE}/assets/`)) {
      if (!(await staticFile(req, res, url))) notFound(res);
      return;
    }
    if (await staticFile(req, res, url)) return;
    return page(req, res, url);
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      log("request failed", { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) sendJson(res, 500, { error: "internal" }, { Connection: "close" });
      else res.destroy();
    });
  });
}
