// GET /upload/health: what an uptime monitor (or a maintainer) watches.
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { get, startHarness, type Harness } from "./testing/harness.ts";

let h: Harness;
afterEach(async () => h?.close());

interface Health {
  status: string;
  paused: boolean;
  resourcespace: { reachable: boolean; configured: boolean };
  staging: { ok: boolean; writable: boolean; usedBytes: number; totalBytes: number; usedPercent: number; capPercent: number };
}

async function health(): Promise<{ status: number; body: Health; res: Response }> {
  const res = await get(h, "/upload/health");
  return { status: res.status, body: (await res.json()) as Health, res };
}

describe("the health endpoint", () => {
  it("reports staging usage and that ResourceSpace is reachable, without a session", async () => {
    h = await startHarness();

    const { status, body, res } = await health();

    expect(status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body.status).toBe("ok");
    expect(body.paused).toBe(false);
    expect(body.resourcespace).toEqual({ reachable: true, configured: true });
    expect(body.staging.ok).toBe(true);
    expect(body.staging.writable).toBe(true);
    expect(body.staging.totalBytes).toBeGreaterThan(0);
    expect(body.staging.usedBytes).toBeGreaterThanOrEqual(0);
    expect(body.staging.usedPercent).toBeGreaterThanOrEqual(0);
    expect(body.staging.usedPercent).toBeLessThanOrEqual(100);
    expect(body.staging.capPercent).toBe(80);
    expect(h.auth.seen).toHaveLength(0);
  });

  it("reaches ResourceSpace directly with the public Host header", async () => {
    h = await startHarness();

    await health();

    expect(h.rs.seen).toHaveLength(1);
    expect(h.rs.seen[0]!.headers.host).toBe("media.example.org");
    expect(h.rs.seen[0]!.headers["x-forwarded-proto"]).toBe("https");
  });

  it("counts a redirect or a login page from ResourceSpace as reachable", async () => {
    h = await startHarness();
    h.rs.respond = () => ({ status: 302, body: "" });

    expect((await health()).body.resourcespace.reachable).toBe(true);
  });

  it.each([
    ["answers with a server error", () => ({ status: 500, body: "db down" })],
    ["never answers", () => ({ hang: true })],
  ])("reports degraded when ResourceSpace %s", async (_name, reply) => {
    h = await startHarness();
    h.rs.respond = reply;

    const { status, body } = await health();

    expect(status).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.resourcespace.reachable).toBe(false);
  });

  it("reports degraded when ResourceSpace is down", async () => {
    h = await startHarness();
    await h.rs.close();

    const { status, body } = await health();

    expect(status).toBe(503);
    expect(body.resourcespace.reachable).toBe(false);
  });

  it("reports degraded when the staging volume is missing", async () => {
    h = await startHarness();
    await rm(h.stagingDir, { recursive: true });

    const { status, body } = await health();

    expect(status).toBe(503);
    expect(body.staging.ok).toBe(false);
  });

  it("reports degraded when staging is at or over its cap", async () => {
    h = await startHarness({ STAGING_CAP_PERCENT: "0" });

    const { status, body } = await health();

    expect(status).toBe(503);
    expect(body.staging.ok).toBe(false);
    expect(body.staging.capPercent).toBe(0);
  });

  it("says when uploads are paused", async () => {
    h = await startHarness({ UPLOADS_PAUSED: "true" });

    const { body } = await health();

    expect(body.paused).toBe(true);
  });
});
