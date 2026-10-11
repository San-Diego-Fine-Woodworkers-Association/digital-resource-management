// The page at /upload: who gets in, who is bounced, and what everyone else sees.
import { afterEach, describe, expect, it } from "vitest";
import {
  COOKIE,
  PUBLIC_BASE_URL,
  UPLOAD_URL,
  bootOf,
  get,
  signedInAs,
  signedOut,
  startHarness,
  type Harness,
} from "./testing/harness.ts";

let h: Harness;
afterEach(async () => h?.close());

describe("signed-out visitors", () => {
  it("are sent to sign in and come straight back to the upload page", async () => {
    h = await startHarness();
    h.auth.respond = signedOut;

    const res = await get(h, "/upload/", COOKIE);

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(`${h.auth.url}/login`);
    expect(location.searchParams.get("redirect")).toBe(UPLOAD_URL);
  });

  it("come back to the exact page and query they asked for", async () => {
    h = await startHarness();

    const res = await get(h, "/upload/step/2?from=email", COOKIE);

    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("redirect")).toBe(`${PUBLIC_BASE_URL}/upload/step/2?from=email`);
  });

  it("are bounced without asking the auth service when they have no cookie at all", async () => {
    h = await startHarness();

    const res = await get(h, "/upload/");

    expect(res.status).toBe(302);
    expect(h.auth.seen).toHaveLength(0);
  });

  it("redirect to the configured public address, never the Host header", async () => {
    h = await startHarness();

    const res = await fetch(h.url + "/upload/", {
      redirect: "manual",
      headers: { cookie: COOKIE, host: "evil.example.com", "x-forwarded-host": "evil.example.com" },
    });

    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("redirect")).toBe(UPLOAD_URL);
  });
});

describe("the session check", () => {
  it("forwards the browser's cookie to the auth session endpoint", async () => {
    h = await startHarness();
    h.auth.respond = signedInAs({ claims: ["member"] });

    await get(h, "/upload/", COOKIE);

    const session = h.auth.seen.find((r) => r.url === "/api/session");
    expect(session?.method).toBe("GET");
    expect(session?.headers.cookie).toBe(COOKIE);
  });
});

describe("signed in without a member or volunteer claim", () => {
  it("sees the friendly page offering renewal or signing in with another login", async () => {
    h = await startHarness({ RENEW_URL: "https://www.example.org/renew" });
    h.auth.respond = signedInAs({ claims: [], name: "Pat Lapsed", email: "pat@example.org" });

    const res = await get(h, "/upload/", COOKIE);

    expect(res.status).toBe(403);
    expect(bootOf(await res.text())).toEqual({
      screen: "not-member",
      user: { name: "Pat Lapsed", email: "pat@example.org" },
      renewUrl: "https://www.example.org/renew",
      signOutUrl: `${h.auth.url}/logout?redirect=${encodeURIComponent(UPLOAD_URL)}`,
    });
  });

  it("is not let in by look-alike claims", async () => {
    h = await startHarness();
    h.auth.respond = signedInAs({ claims: ["tier:gold", "members", "Volunteer"] });

    const res = await get(h, "/upload/", COOKIE);

    expect(res.status).toBe(403);
  });
});

describe.each([["member"], ["volunteer"]])("signed in with the %s claim", (claim) => {
  it("sees the app shell with their name and a sign-out link", async () => {
    h = await startHarness();
    h.auth.respond = signedInAs({ claims: [claim], name: "Pat Member", email: "pat@example.org" });

    const res = await get(h, "/upload/", COOKIE);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(bootOf(await res.text())).toEqual({
      screen: "app",
      user: { name: "Pat Member", email: "pat@example.org" },
      signOutUrl: `${h.auth.url}/logout?redirect=${encodeURIComponent(UPLOAD_URL)}`,
    });
  });
});

describe("the signed-in name", () => {
  it("falls back to the email when the auth service cannot give a name", async () => {
    h = await startHarness();
    const member = signedInAs({ claims: ["member"], email: "pat@example.org" });
    h.auth.respond = (req) => (req.url.startsWith("/api/user") ? { status: 500, body: "" } : member(req));

    const res = await get(h, "/upload/", COOKIE);

    expect(res.status).toBe(200);
    expect(bootOf(await res.text())).toMatchObject({ user: { name: "pat@example.org" } });
  });

  it("cannot inject markup into the page", async () => {
    h = await startHarness();
    h.auth.respond = signedInAs({ claims: ["member"], name: "</script><script>alert(1)</script>" });

    const html = await (await get(h, "/upload/", COOKIE)).text();

    expect(html).not.toContain("<script>alert(1)");
    expect(bootOf(html)).toMatchObject({ user: { name: "</script><script>alert(1)</script>" } });
  });
});

describe("an auth service outage", () => {
  const outages: [string, () => { status?: number; json?: unknown; body?: string; hang?: boolean }][] = [
    ["answers with a server error", () => ({ status: 502, body: "Bad Gateway" })],
    ["answers with something that is not JSON", () => ({ status: 200, body: "<html>maintenance</html>" })],
    ["answers without a user field", () => ({ json: { error: "oops" } })],
    ["answers a user without claims", () => ({ json: { user: { id: "1", email: "a@b.c" } } })],
    ["never answers", () => ({ hang: true })],
  ];

  it.each(outages)("is a temporary error when it %s, never a sign-in redirect", async (_name, reply) => {
    h = await startHarness();
    h.auth.respond = reply;

    const res = await get(h, "/upload/", COOKIE);

    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(bootOf(await res.text())).toEqual({ screen: "unavailable" });
  });

  it("is a temporary error when it cannot be reached at all", async () => {
    h = await startHarness();
    await h.auth.close();

    const res = await get(h, "/upload/", COOKIE);

    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("the kill switch", () => {
  it("shows the paused page to everyone without checking sign-in", async () => {
    h = await startHarness({ UPLOADS_PAUSED: "true" });
    h.auth.respond = signedInAs({ claims: ["member"] });

    const res = await get(h, "/upload/", COOKIE);

    expect(res.status).toBe(503);
    expect(bootOf(await res.text())).toEqual({ screen: "paused" });
    expect(h.auth.seen).toHaveLength(0);
  });
});

describe("serving the page", () => {
  it("answers /upload without the trailing slash the same way", async () => {
    h = await startHarness();
    h.auth.respond = signedInAs({ claims: ["member"] });

    const res = await get(h, "/upload", COOKIE);

    expect(res.status).toBe(200);
    expect(bootOf(await res.text())).toMatchObject({ screen: "app" });
  });

  it("is never cached, and is locked down against framing and injected scripts", async () => {
    h = await startHarness();
    h.auth.respond = signedInAs({ claims: ["member"] });

    const res = await get(h, "/upload/", COOKIE);

    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'self'");
  });

  it("serves the built scripts and styles without a session", async () => {
    h = await startHarness();

    const res = await get(h, "/upload/assets/app.js");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(await res.text()).toContain("console.log");
    expect(h.auth.seen).toHaveLength(0);
  });

  it("never serves files outside the built app", async () => {
    h = await startHarness();

    for (const p of ["/upload/assets/..%2f..%2fsecret.txt", "/upload/..%2fsecret.txt", "/upload/assets/%2e%2e/%2e%2e/secret.txt"]) {
      const res = await get(h, p);
      expect(await res.text()).not.toContain("outside the web root");
    }
  });

  it("answers only under /upload", async () => {
    h = await startHarness();

    expect((await get(h, "/", COOKIE)).status).toBe(404);
    expect((await get(h, "/uploads", COOKIE)).status).toBe(404);
    expect((await get(h, "/pages/home.php", COOKIE)).status).toBe(404);
  });
});
