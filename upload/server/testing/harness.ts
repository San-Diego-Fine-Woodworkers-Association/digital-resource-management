// Test harness for seam 1: the upload service's HTTP boundary.
//
// Starts the real service on an ephemeral port, plus two fakes that stand in
// for the outside parties as real HTTP servers: the auth service
// (auth.sdfwa.org) and ResourceSpace. Tests drive the service as a browser
// would and decide how the fakes answer.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../config.ts";
import { createService, type Service } from "../app.ts";
import { statVolume, type SweepReport, type VolumeStats } from "../staging.ts";
import { createFakeResourceSpace, FAKE_RS_KEY, FAKE_RS_USER, type FakeResourceSpace } from "./fake-rs.ts";

export const PUBLIC_BASE_URL = "https://media.example.org";
export const UPLOAD_URL = `${PUBLIC_BASE_URL}/upload/`;

export interface FakeReply {
  status?: number;
  json?: unknown;
  body?: string;
  /** Never answer (to exercise timeouts). */
  hang?: boolean;
  /** Answer only after this long (as ResourceSpace does while it makes a video's previews). */
  delayMs?: number;
}

export interface SeenRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export interface FakeServer {
  url: string;
  seen: SeenRequest[];
  respond: (req: SeenRequest) => FakeReply;
  close: () => Promise<void>;
}

async function startFake(initial: (req: SeenRequest) => FakeReply): Promise<FakeServer> {
  const sockets = new Set<import("node:net").Socket>();
  const fake: FakeServer = {
    url: "",
    seen: [],
    respond: initial,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) };
    fake.seen.push(seen);
    const reply = fake.respond(seen);
    if (reply.hang) return;
    if (reply.delayMs) await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
    if (reply.json !== undefined) {
      res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.json));
    } else {
      res.writeHead(reply.status ?? 200, { "content-type": "text/html" });
      res.end(reply.body ?? "");
    }
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}

// --- Auth service replies -------------------------------------------------

export interface FakeUser {
  id?: string;
  email?: string;
  memberId?: string | null;
  claims: string[];
  name?: string;
}

/** The auth service's answers for someone signed in with these claims. */
export function signedInAs(user: FakeUser): (req: SeenRequest) => FakeReply {
  const full = {
    id: user.id ?? "user-1",
    email: user.email ?? "pat@example.org",
    memberId: user.memberId === undefined ? "M-100" : user.memberId,
    membership: user.claims.includes("member") ? "Gold" : null,
    groups: [],
    claims: user.claims,
  };
  return (req) => {
    if (req.url.startsWith("/api/session")) {
      return { json: { user: full, expiresAt: "2099-01-01T00:00:00.000Z" } };
    }
    if (req.url.startsWith("/api/user")) {
      return { json: { id: full.id, email: full.email, name: user.name ?? "Pat Member" } };
    }
    return { status: 404, body: "not found" };
  };
}

/** The auth service's answer when nobody is signed in: always 200. */
export const signedOut = (): FakeReply => ({ json: { user: null } });

// --- The service under test ----------------------------------------------

export const INDEX_HTML = `<!doctype html><html lang="en"><head><meta charset="UTF-8" /><title>Share your photos and videos</title><script type="module" src="/upload/assets/app.js"></script></head><body><div id="root"></div></body></html>`;

export interface Harness {
  url: string;
  auth: FakeServer;
  rs: FakeServer;
  /** What the fake ResourceSpace API holds and was asked. */
  fakeRs: FakeResourceSpace;
  stagingDir: string;
  auditLines: string[];
  /** The service's operational log, one entry per message. */
  logLines: { message: string; fields?: Record<string, unknown> }[];
  /** Moves the service's clock on (quotas, rate limits, the sweep), instead of waiting. */
  advance: (ms: number) => void;
  /** When set, how full the staging volume says it is; otherwise the real figures. */
  volume?: VolumeStats;
  /** Runs the staging sweep now. */
  sweep: () => Promise<SweepReport>;
  /** Stops the service and starts it again on the same staging volume, as a redeploy does. */
  restart: () => Promise<void>;
  close: () => Promise<void>;
}

export interface HarnessOptions {
  /**
   * The hand-off's own pauses before trying ResourceSpace again (items.ts).
   * None by default, so a test's failure on demand reaches the page as it is;
   * the tests of those retries set them.
   */
  rsRetryDelaysMs?: number[];
}

export async function startHarness(env: Record<string, string> = {}, opts: HarnessOptions = {}): Promise<Harness> {
  const auth = await startFake(signedOut);
  const fakeRs = createFakeResourceSpace();
  const rs = await startFake((req) =>
    req.url.startsWith("/api/") ? fakeRs.handle(req) : { status: 200, body: "<html>ResourceSpace</html>" },
  );

  const work = await mkdtemp(path.join(tmpdir(), "upload-test-"));
  const stagingDir = path.join(work, "staging");
  const webRoot = path.join(work, "web");
  await mkdir(stagingDir);
  await mkdir(path.join(webRoot, "assets"), { recursive: true });
  await writeFile(path.join(webRoot, "index.html"), INDEX_HTML);
  await writeFile(path.join(webRoot, "assets", "app.js"), "console.log('app');");
  await writeFile(path.join(work, "secret.txt"), "outside the web root");

  const auditLines: string[] = [];
  const logLines: Harness["logLines"] = [];
  const config = loadConfig({
    PUBLIC_BASE_URL,
    AUTH_BASE_URL: auth.url,
    RS_BASE_URL: rs.url,
    STAGING_DIR: stagingDir,
    WEB_ROOT: webRoot,
    AUTH_TIMEOUT_MS: "500",
    RS_TIMEOUT_MS: "500",
    RS_UPLOADER_USER: FAKE_RS_USER,
    RS_UPLOADER_API_KEY: FAKE_RS_KEY,
    ...env,
  });
  let skew = 0;
  let service: Service;
  async function start() {
    service = createService(config, {
      auditSink: (line) => auditLines.push(line),
      log: (message, fields) => logLines.push({ message, fields }),
      readBackRetryDelayMs: 1,
      rsRetryDelaysMs: opts.rsRetryDelaysMs ?? [],
      // Real time, moved on by `advance`, so the times of files on staging still compare.
      now: () => Date.now() + skew,
      stagingStats: async (dir) => h.volume ?? statVolume(dir),
    });
    await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
    await service.ready;
    h.url = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
  }
  async function stop() {
    service.closeAllConnections();
    await new Promise<void>((resolve) => service.close(() => resolve()));
  }

  const h: Harness = {
    url: "",
    auth,
    rs,
    fakeRs,
    stagingDir,
    auditLines,
    logLines,
    advance: (ms) => {
      skew += ms;
    },
    sweep: () => service.sweep(),
    restart: async () => {
      await stop();
      await start();
    },
    close: async () => {
      await stop();
      await auth.close();
      await rs.close();
      await rm(work, { recursive: true, force: true });
    },
  };
  await start();
  return h;
}

/** A browser-like request: never follows redirects, so tests see them. */
export function get(h: Harness, pathname: string, cookie?: string): Promise<Response> {
  return fetch(h.url + pathname, {
    redirect: "manual",
    headers: cookie ? { cookie } : {},
  });
}

/** Reads the boot JSON the service embedded in the page. */
export function bootOf(html: string): unknown {
  const m = html.match(/<script type="application\/json" id="boot">([\s\S]*?)<\/script>/);
  if (!m?.[1]) throw new Error("no boot data in page");
  return JSON.parse(m[1]);
}

export const COOKIE = "__Secure-better-auth.session_token=abc.def; other=1";
