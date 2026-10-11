// The API under /upload/api: the session is re-checked on every call, before
// any of the request body is read; the kill switch refuses writes; every
// write attempt leaves one audit line.
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { COOKIE, signedInAs, signedOut, startHarness, type Harness } from "./testing/harness.ts";

let h: Harness;
afterEach(async () => h?.close());

function api(pathname: string, init: RequestInit & { cookie?: string } = {}) {
  const { cookie = COOKIE, ...rest } = init;
  return fetch(h.url + "/upload/api" + pathname, {
    redirect: "manual",
    ...rest,
    headers: { cookie, ...(rest.headers as Record<string, string> | undefined) },
  });
}

/**
 * Starts a POST whose body never finishes and resolves with the response.
 * A service that read the body before answering would never answer.
 */
function postWithEndlessBody(pathname: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(h.url + "/upload/api" + pathname, {
      method: "POST",
      headers: { cookie: COOKIE, "content-type": "application/offset+octet-stream", "content-length": "1000000000" },
    });
    req.on("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body });
        req.destroy();
      });
    });
    req.on("error", reject);
    req.write(Buffer.alloc(64 * 1024, 1));
  });
}

describe("GET /upload/api/session", () => {
  it("answers who is signed in for a member", async () => {
    h = await startHarness();
    h.auth.respond = signedInAs({ claims: ["member"], name: "Pat Member", email: "pat@example.org" });

    const res = await api("/session");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: { name: "Pat Member", email: "pat@example.org" } });
  });

  it("answers 401 with where to sign in when signed out", async () => {
    h = await startHarness();
    h.auth.respond = signedOut;

    const res = await api("/session");

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "signed_out" });
  });

  it("answers 403 when signed in without a member or volunteer claim", async () => {
    h = await startHarness();
    h.auth.respond = signedInAs({ claims: [] });

    const res = await api("/session");

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "not_member" });
  });

  it("answers a retryable 503 during an auth outage, not 401", async () => {
    h = await startHarness();
    h.auth.respond = () => ({ status: 500, body: "" });

    const res = await api("/session");

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(await res.json()).toMatchObject({ error: "auth_unavailable" });
  });

  it("is never cached", async () => {
    h = await startHarness();
    h.auth.respond = signedInAs({ claims: ["member"] });

    const res = await api("/session");

    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("every API call", () => {
  it("re-checks the session with the auth service", async () => {
    h = await startHarness();
    h.auth.respond = signedInAs({ claims: ["volunteer"] });

    expect((await api("/session")).status).toBe(200);
    h.auth.respond = signedOut;
    expect((await api("/session")).status).toBe(401);

    expect(h.auth.seen.filter((r) => r.url === "/api/session")).toHaveLength(2);
  });

  it("checks the session before reading any of the request body", async () => {
    h = await startHarness();
    h.auth.respond = signedOut;

    const res = await postWithEndlessBody("/files");

    expect(res.status).toBe(401);
    expect(h.auth.seen.some((r) => r.url === "/api/session")).toBe(true);
  });

  it("answers unknown API paths with 404 only after the session check", async () => {
    h = await startHarness();
    h.auth.respond = signedOut;
    expect((await api("/nope")).status).toBe(401);

    h.auth.respond = signedInAs({ claims: ["member"] });
    expect((await api("/nope")).status).toBe(404);
  });
});

describe("the kill switch", () => {
  it("refuses writes before checking the session or reading the body", async () => {
    h = await startHarness({ UPLOADS_PAUSED: "1" });
    h.auth.respond = signedInAs({ claims: ["member"] });

    const res = await postWithEndlessBody("/files");

    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({ error: "paused" });
    expect(h.auth.seen).toHaveLength(0);
  });

  it.each(["PUT", "PATCH", "DELETE"])("refuses %s too", async (method) => {
    h = await startHarness({ UPLOADS_PAUSED: "1" });
    h.auth.respond = signedInAs({ claims: ["member"] });

    const res = await api("/files/abc", { method });

    expect(res.status).toBe(503);
  });

  it("still lets the page ask who is signed in", async () => {
    h = await startHarness({ UPLOADS_PAUSED: "1" });
    h.auth.respond = signedInAs({ claims: ["member"] });

    expect((await api("/session")).status).toBe(200);
  });
});

describe("the audit log", () => {
  it("writes one structured line per write attempt, with who and the outcome", async () => {
    h = await startHarness();
    h.auth.respond = signedInAs({ claims: ["member"], email: "pat@example.org", id: "u-42" });

    await api("/files", { method: "POST", body: "SECRET-FILE-BYTES" });

    expect(h.auditLines).toHaveLength(1);
    const line = JSON.parse(h.auditLines[0]!);
    expect(line).toMatchObject({
      audit: true,
      event: "upload_request",
      method: "POST",
      path: "/upload/api/files",
      outcome: "not_found",
      user: { id: "u-42", email: "pat@example.org" },
    });
    expect(typeof line.time).toBe("string");
  });

  it.each([
    ["signed_out", {}, signedOut],
    ["not_member", {}, signedInAs({ claims: [] })],
    ["auth_unavailable", {}, () => ({ status: 500, body: "" })],
    ["paused", { UPLOADS_PAUSED: "true" }, signedInAs({ claims: ["member"] })],
  ] as const)("records refused writes (%s)", async (outcome, env, auth) => {
    h = await startHarness(env);
    h.auth.respond = auth;

    await api("/files", { method: "POST", body: "x" });

    expect(h.auditLines.map((l) => JSON.parse(l).outcome)).toEqual([outcome]);
  });

  it("never records file contents or the cookie", async () => {
    h = await startHarness();
    h.auth.respond = signedInAs({ claims: ["member"] });

    await api("/files", { method: "POST", body: "SECRET-FILE-BYTES" });

    expect(h.auditLines.join("\n")).not.toContain("SECRET-FILE-BYTES");
    expect(h.auditLines.join("\n")).not.toContain("abc.def");
  });

  it("does not record reads", async () => {
    h = await startHarness();
    h.auth.respond = signedInAs({ claims: ["member"] });

    await api("/session");

    expect(h.auditLines).toHaveLength(0);
  });
});
