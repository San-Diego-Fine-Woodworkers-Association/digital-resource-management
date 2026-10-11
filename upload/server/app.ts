// The upload service's HTTP surface, everything under /upload:
//
//   /upload, /upload/...   the page, gated on the SDFWA session
//   /upload/assets/...     the built app's scripts and styles (public)
//   /upload/api/...        the narrow API; session re-checked on every call
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
import { checkSession, displayName, isEntitled, type Session, type SessionUser } from "./session.ts";

export interface ServiceOptions {
  auditSink?: AuditSink;
  /** Operational messages (not the audit trail). */
  log?: (message: string, fields?: Record<string, unknown>) => void;
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
  const log =
    options.log ??
    ((message: string, fields: Record<string, unknown> = {}) =>
      process.stderr.write(JSON.stringify({ time: new Date().toISOString(), message, ...fields }) + "\n"));

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
    return sendPage(res, 200, { screen: "app", user, signOutUrl });
  }

  // --- the API -------------------------------------------------------------

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    const method = req.method ?? "GET";
    const isWrite = !READ_METHODS.has(method);
    // Nothing here reads the request body: every refusal is decided from the
    // headers alone. When a write is refused, the connection is closed rather
    // than draining a body we will never use.
    const answer = (
      status: number,
      body: unknown,
      outcome: string,
      user?: SessionUser,
      headers: Record<string, string> = {},
    ) => {
      if (isWrite) {
        const forwarded = req.headers["x-forwarded-for"];
        const event: AuditEvent = {
          event: "upload_request",
          outcome,
          method,
          path: url.pathname,
          user,
          ip: (typeof forwarded === "string" ? forwarded.slice(0, 200) : undefined) ?? req.socket.remoteAddress,
        };
        audit.record(event);
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
    return answer(404, { error: "not_found" }, "not_found", s.user);
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
      const health = await checkHealth(config);
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
