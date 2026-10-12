// Seam 1: protecting the service (#60). Each quota and limit refuses with
// its own plain answer (a status and an error the page maps to words) and
// lifts by itself when its window passes. Time is moved on with the
// harness's clock rather than waited for, and the staging volume's figures
// are faked.
import http from "node:http";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ANSWERS, client, jpeg, member, mp4, png } from "./testing/client.ts";
import { bootOf, COOKIE, get, signedInAs, startHarness, type Harness } from "./testing/harness.ts";

let h: Harness;
afterEach(async () => h?.close());

const DAY_MS = 24 * 60 * 60 * 1000;
const MiB = 1024 * 1024;

/** Sends `body` into an upload from `offset` in one PATCH, as tus does. */
function patch(id: string, offset: number, body: Buffer, cookie = COOKIE) {
  return fetch(`${h.url}/upload/api/files/${id}`, {
    method: "PATCH",
    headers: {
      cookie,
      "tus-resumable": "1.0.0",
      "upload-offset": String(offset),
      "content-type": "application/offset+octet-stream",
    },
    body: new Uint8Array(body),
  });
}

/** Starts an upload of `size` bytes; resolves with its id. */
async function create(submission: string, size: number, cookie = COOKIE): Promise<string> {
  const res = await client(h).create(submission, size, cookie);
  if (res.status !== 201) throw new Error(`create answered ${res.status}: ${await res.text()}`);
  return res.headers.get("location")!.split("/").pop()!;
}

/**
 * A chunk that is still arriving: half of it is sent and the request is held
 * open (a slow phone), until `finish` sends the rest.
 */
async function slowChunk(id: string, body: Buffer) {
  const req = http.request(`${h.url}/upload/api/files/${id}`, {
    method: "PATCH",
    headers: {
      cookie: COOKIE,
      "tus-resumable": "1.0.0",
      "upload-offset": "0",
      "content-type": "application/offset+octet-stream",
      "content-length": String(body.length),
    },
  });
  const answered = new Promise<number>((resolve, reject) => {
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
  });
  const half = Math.floor(body.length / 2);
  req.write(body.subarray(0, half));
  // Until the service is writing it.
  for (let i = 0; i < 200; i++) {
    if ((await stat(path.join(h.stagingDir, id)).catch(() => undefined))?.size) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return {
    finish: () => {
      req.end(body.subarray(half));
      return answered;
    },
  };
}

async function refusal(res: Response) {
  return { status: res.status, body: await res.json(), retryAfter: Number(res.headers.get("retry-after")) };
}

describe("at most two uploads arriving at once, per member", () => {
  it("refuses a third while two are arriving, and takes it once one is done", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const submission = await client(h).startSubmission(COOKIE, { expectedItems: 3, details: ANSWERS, rightsConfirmed: true });
    const files = [mp4(200_000), mp4(200_000), jpeg(100_000)];
    const [a, b, c] = [await create(submission, 200_000), await create(submission, 200_000), await create(submission, 100_000)];
    const first = await slowChunk(a, files[0]!);
    const second = await slowChunk(b, files[1]!);

    const third = await patch(c, 0, files[2]!);
    expect(await refusal(third)).toEqual({ status: 429, body: { error: "too_many_at_once" }, retryAfter: 15 });
    // Nothing of it was written.
    expect((await stat(path.join(h.stagingDir, c))).size).toBe(0);

    expect(await first.finish()).toBe(204);
    expect((await patch(c, 0, files[2]!)).status).toBe(204);
    expect(await second.finish()).toBe(204);
  });

  it("is per member: someone else still sends", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const submission = await client(h).startSubmission();
    const [a, b] = [await create(submission, 200_000), await create(submission, 200_000)];
    const first = await slowChunk(a, mp4(200_000));
    const second = await slowChunk(b, mp4(200_000));

    h.auth.respond = signedInAs({ claims: ["member"], id: "someone-else" });
    const theirs = await client(h).startSubmission();
    const id = await create(theirs, 100_000);
    expect((await patch(id, 0, jpeg(100_000))).status).toBe(204);

    h.auth.respond = member();
    await first.finish();
    await second.finish();
  });
});

describe("at most 4 GB on staging at once, per member", () => {
  it("refuses a new upload that would take the member over, until what they sent is handed over", async () => {
    h = await startHarness({ QUOTA_STAGED_BYTES: "250000" });
    h.auth.respond = member();
    const c = client(h);
    const submission = await c.startSubmission(COOKIE, { expectedItems: 2, details: ANSWERS, rightsConfirmed: true });
    const first = await c.upload(jpeg(200_000), { submission });

    const over = await c.create(submission, 100_000);
    expect(await refusal(over)).toEqual({ status: 429, body: { error: "too_much_staged" }, retryAfter: 60 });

    expect((await c.finish(first)).status).toBe(200);
    expect((await c.create(submission, 100_000)).status).toBe(201);
  });

  it("refuses a chunk that would take the member over, and nothing of it is written", async () => {
    h = await startHarness({ QUOTA_STAGED_BYTES: "250000" });
    h.auth.respond = member();
    const c = client(h);
    const submission = await c.startSubmission(COOKIE, { expectedItems: 2, details: ANSWERS, rightsConfirmed: true });
    // Both start while nothing is on staging yet; only what arrives counts.
    const a = await create(submission, 200_000);
    const b = await create(submission, 200_000);
    expect((await patch(a, 0, jpeg(200_000))).status).toBe(204);

    const res = await patch(b, 0, png(200_000));
    expect(await refusal(res)).toEqual({ status: 429, body: { error: "too_much_staged" }, retryAfter: 60 });
    expect((await stat(path.join(h.stagingDir, b))).size).toBe(0);

    expect((await c.finish(a)).status).toBe(200);
    expect((await patch(b, 0, png(200_000))).status).toBe(204);
  });

  it("counts a half-sent upload only for what arrived", async () => {
    h = await startHarness({ QUOTA_STAGED_BYTES: "250000" });
    h.auth.respond = member();
    const submission = await client(h).startSubmission();
    const given_up = await create(submission, 200_000);
    expect((await patch(given_up, 0, mp4(200_000).subarray(0, 50_000))).status).toBe(204);

    const next = await client(h).startSubmission();
    expect((await client(h).create(next, 200_000)).status).toBe(201);
  });
});

describe("at most 100 photos and videos in 24 hours, per member", () => {
  it("refuses the next one with its own reason, and takes it again once the day has passed", async () => {
    h = await startHarness({ QUOTA_DAILY_ITEMS: "2" });
    h.auth.respond = member();
    const c = client(h);
    for (let i = 0; i < 2; i++) await c.finish(await c.upload(jpeg()));
    // Handing them over does not give the day back.
    const submission = await c.startSubmission();

    const res = await c.create(submission, 100_000);
    const r = await refusal(res);
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ error: "too_many_today" });
    expect(r.retryAfter).toBeGreaterThan(DAY_MS / 1000 - 60);
    expect(r.retryAfter).toBeLessThanOrEqual(DAY_MS / 1000);

    h.advance(DAY_MS - 60_000);
    expect((await c.create(submission, 100_000)).status).toBe(429);
    h.advance(61_000);
    expect((await c.create(submission, 100_000)).status).toBe(201);
  });

  it("is told to the page in words of its own", async () => {
    h = await startHarness({ QUOTA_DAILY_ITEMS: "1" });
    h.auth.respond = member();
    const c = client(h);
    const submission = await c.startSubmission(COOKIE, { expectedItems: 2, details: ANSWERS, rightsConfirmed: true });
    await c.upload(jpeg(), { submission });

    await expect(c.upload(png(), { submission })).rejects.toThrow(/429.*too_many_today/);
  });
});

describe("at most 10 GB in 24 hours, per member", () => {
  it("refuses an upload that would go over, and takes it once the day has passed", async () => {
    h = await startHarness({ QUOTA_DAILY_BYTES: "250000" });
    h.auth.respond = member();
    const c = client(h);
    await c.finish(await c.upload(jpeg(200_000)));
    const submission = await c.startSubmission();

    expect(await refusal(await c.create(submission, 100_000))).toMatchObject({ status: 429, body: { error: "too_much_today" } });
    // Something small enough still fits.
    expect((await c.create(submission, 40_000)).status).toBe(201);

    h.advance(DAY_MS + 1000);
    expect((await c.create(submission, 100_000)).status).toBe(201);
  });

  it("gives back what never arrived of an upload the member took out", async () => {
    h = await startHarness({ QUOTA_DAILY_BYTES: "250000" });
    h.auth.respond = member();
    const submission = await client(h).startSubmission(COOKIE, { expectedItems: 2, details: ANSWERS, rightsConfirmed: true });
    const id = await create(submission, 200_000);
    await patch(id, 0, mp4(200_000).subarray(0, 20_000));
    expect((await client(h).create(submission, 100_000)).status).toBe(429);

    const del = await fetch(`${h.url}/upload/api/files/${id}`, { method: "DELETE", headers: { cookie: COOKIE, "tus-resumable": "1.0.0" } });
    expect(del.status).toBe(204);

    // 20 000 of the day are used; 100 000 more fit.
    expect((await client(h).create(submission, 100_000)).status).toBe(201);
  });
});

describe("Submissions started in 24 hours, per member", () => {
  it("are limited too, since each leaves a record on staging until the sweep", async () => {
    h = await startHarness({ QUOTA_DAILY_SUBMISSIONS: "1" });
    h.auth.respond = member();
    const c = client(h);
    await c.startSubmission();

    const res = await c.begin();
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "too_many_today" });
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);

    h.advance(DAY_MS + 1000);
    expect((await c.begin()).status).toBe(201);
  });
});

describe("the request rate limit", () => {
  const session = (cookie = COOKIE) => fetch(`${h.url}/upload/api/session`, { headers: { cookie } });

  it("per member: refuses past the burst, and lets them go on a moment later", async () => {
    h = await startHarness({ RATE_USER_BURST: "3", RATE_USER_PER_MINUTE: "60" });
    h.auth.respond = member();
    for (let i = 0; i < 3; i++) expect((await session()).status).toBe(200);

    const res = await session();
    expect(await refusal(res)).toEqual({ status: 429, body: { error: "rate_limited" }, retryAfter: 1 });

    // Someone else, from the same address, is not held up.
    h.auth.respond = signedInAs({ claims: ["member"], id: "someone-else" });
    expect((await session()).status).toBe(200);

    h.auth.respond = member();
    h.advance(1000);
    expect((await session()).status).toBe(200);
  });

  it("per address: refuses past the burst before asking the auth service anything", async () => {
    h = await startHarness({ RATE_IP_BURST: "2", RATE_IP_PER_MINUTE: "60" });
    h.auth.respond = member();
    await session();
    await session();
    const asked = h.auth.seen.length;

    expect(await refusal(await session())).toEqual({ status: 429, body: { error: "rate_limited" }, retryAfter: 1 });
    expect((await get(h, "/upload/health")).status).toBe(429);
    // The page says so in plain words.
    const page = await get(h, "/upload/", COOKIE);
    expect(page.status).toBe(429);
    expect(bootOf(await page.text())).toEqual({ screen: "unavailable" });
    expect(h.auth.seen.length).toBe(asked);

    // The app's own files are never held up.
    expect((await get(h, "/upload/assets/app.js")).status).toBe(200);

    h.advance(1000);
    expect((await session()).status).toBe(200);
  });

  it("takes the address from the last X-Forwarded-For entry, the one Traefik sets, so a client cannot choose it", async () => {
    h = await startHarness({ RATE_IP_BURST: "1", RATE_IP_PER_MINUTE: "1" });
    const from = (forwarded: string) => fetch(`${h.url}/upload/health`, { headers: { "x-forwarded-for": forwarded } });

    expect((await from("203.0.113.7")).status).toBe(200);
    // Whatever a client puts in front, the address Traefik added decides.
    expect((await from("198.51.100.1, 203.0.113.7")).status).toBe(429);
    expect((await from("198.51.100.2,203.0.113.7")).status).toBe(429);
    // A different client is someone else.
    expect((await from("203.0.113.8")).status).toBe(200);
    // An IPv6 connection's whole /64 is one address.
    expect((await from("2001:db8:1:2::10")).status).toBe(200);
    expect((await from("2001:db8:1:2:aaaa::99")).status).toBe(429);
    expect((await from("2001:db8:1:3::10")).status).toBe(200);
  });

  it("records the address Traefik saw in the audit log", async () => {
    h = await startHarness();
    h.auth.respond = member();
    await fetch(`${h.url}/upload/api/submissions`, {
      method: "POST",
      headers: { cookie: COOKIE, "content-type": "application/json", "x-forwarded-for": "10.0.0.1, 203.0.113.7" },
      body: "{}",
    });
    expect(JSON.parse(h.auditLines.at(-1)!).ip).toBe("203.0.113.7");
  });
});

describe("the staging cap", () => {
  /** A 1000 MiB volume with this much used. */
  const used = (mib: number, available = 1000 - mib) => ({
    totalBytes: 1000 * MiB,
    freeBytes: (1000 - mib) * MiB,
    availableBytes: available * MiB,
  });

  it("answers busy to a new upload at 80% of the volume, and takes it again below", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const c = client(h);
    const submission = await c.startSubmission();
    h.volume = used(801);

    expect(await refusal(await c.create(submission, 100_000))).toEqual({ status: 503, body: { error: "busy" }, retryAfter: 120 });

    h.volume = used(500);
    expect((await c.create(submission, 100_000)).status).toBe(201);
  });

  it("answers busy to a chunk that would go over the cap; nothing is written, and it carries on below", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const submission = await client(h).startSubmission();
    const id = await create(submission, 200_000);
    const before = await tree(path.dirname(h.stagingDir));
    // Under the cap, but not by a whole chunk.
    h.volume = { ...used(800), freeBytes: 200 * MiB + 100_000 };

    const res = await patch(id, 0, mp4(200_000));
    expect(await refusal(res)).toEqual({ status: 503, body: { error: "busy" }, retryAfter: 120 });
    expect((await stat(path.join(h.stagingDir, id))).size).toBe(0);
    expect(await tree(path.dirname(h.stagingDir))).toEqual(before);

    h.volume = used(100);
    expect((await patch(id, 0, mp4(200_000))).status).toBe(204);
    expect((await client(h).finish(id)).status).toBe(200);
  });

  it("answers busy when the space free to the service is less than the chunk, whatever the cap", async () => {
    h = await startHarness({ STAGING_CAP_PERCENT: "100" });
    h.auth.respond = member();
    const submission = await client(h).startSubmission();
    const id = await create(submission, 200_000);
    // Root's reserved blocks: free, but not to the service's user.
    h.volume = used(980, 10);

    expect((await patch(id, 0, mp4(200_000))).status).toBe(503);
  });

  it("is reported by the health endpoint", async () => {
    h = await startHarness();
    h.volume = used(850);

    const res = await get(h, "/upload/health");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { staging: unknown }).staging).toMatchObject({ ok: false, usedPercent: 85, capPercent: 80 });
  });
});

describe("while ResourceSpace is not answering", () => {
  /** ResourceSpace's front page fails; its API still answers (a half-broken ResourceSpace is the hardest case). */
  function down() {
    h.rs.respond = (req) => (req.url.startsWith("/api/") ? h.fakeRs.handle(req) : { status: 502, body: "Bad gateway" });
  }
  function up() {
    h.rs.respond = (req) => (req.url.startsWith("/api/") ? h.fakeRs.handle(req) : { status: 200, body: "<html>ResourceSpace</html>" });
  }

  it("takes no new Submission or upload, and takes them again once it answers", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const c = client(h);
    const submission = await c.startSubmission();
    h.advance(60_000);
    down();

    expect(await refusal(await c.begin())).toEqual({ status: 503, body: { error: "unavailable" }, retryAfter: 30 });
    expect(await refusal(await c.create(submission, 100_000))).toEqual({ status: 503, body: { error: "unavailable" }, retryAfter: 30 });
    expect(JSON.parse(h.auditLines.at(-1)!).outcome).toBe("rs_unreachable");

    up();
    h.advance(6_000);
    expect((await c.begin()).status).toBe(201);
    expect((await c.create(submission, 100_000)).status).toBe(201);
  });

  it("lets an upload already started finish arriving", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const submission = await client(h).startSubmission();
    const id = await create(submission, 100_000);
    h.advance(60_000);
    down();

    expect((await patch(id, 0, jpeg(100_000))).status).toBe(204);
  });

  it("shows the busy page rather than a form that cannot send", async () => {
    h = await startHarness();
    h.auth.respond = member();
    down();

    const res = await get(h, "/upload/", COOKIE);
    expect(res.status).toBe(503);
    expect(bootOf(await res.text())).toEqual({ screen: "unavailable" });
  });

  it("asks ResourceSpace only now and then, not for every upload", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const c = client(h);
    const submission = await c.startSubmission(COOKIE, { expectedItems: 3, details: ANSWERS, rightsConfirmed: true });
    for (let i = 0; i < 3; i++) await c.create(submission, 1000);

    expect(h.rs.seen.filter((r) => !r.url.startsWith("/api/"))).toHaveLength(1);
  });
});

describe("every refusal", () => {
  it("is a different error, so the page can say which", async () => {
    const { REFUSAL_STATUS } = await import("./uploads.ts");
    const codes = ["too_many_at_once", "too_much_staged", "rate_limited", "busy", "unavailable", ...Object.keys(REFUSAL_STATUS)];
    expect(new Set(codes).size).toBe(codes.length);
  });
});

/** Every path under `dir`, relative to it. */
async function tree(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries.map((e) => e.split(path.sep).join("/")).sort();
}
