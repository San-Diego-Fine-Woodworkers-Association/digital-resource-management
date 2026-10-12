// Seam 1: big videos (#55). A video goes up in chunks and survives a
// dropped connection by resuming from what the service already has; the
// hand-off to ResourceSpace, which takes minutes for a big video, carries on
// after the page stops waiting, and the page polls the Item's status.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readdir, rm, mkdtemp } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tus from "tus-js-client";
import { afterEach, describe, expect, it } from "vitest";
import { client, jpeg, member, mov, mp4 } from "./testing/client.ts";
import { COOKIE, signedInAs, startHarness, type Harness, type SeenRequest } from "./testing/harness.ts";
import { startProxy, type DroppingProxy } from "./testing/proxy.ts";

let h: Harness;
let proxy: DroppingProxy | undefined;
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
  for (const c of cleanups.splice(0)) await c();
  await h?.close();
});

const MB = 1024 * 1024;
const GiB = 1024 * MB;

const status = (id: string, cookie = COOKIE) =>
  fetch(`${h.url}/upload/api/items/${id}`, { headers: { cookie } });

async function statusOf(id: string): Promise<unknown> {
  const res = await status(id);
  return res.json();
}

/** Polls the Item's status as the page does, until it is no longer finishing. */
async function settle(id: string): Promise<unknown> {
  for (let i = 0; i < 200; i++) {
    const body = (await statusOf(id)) as { status: string };
    if (body.status !== "finishing") return body;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("still finishing");
}

/** Makes ResourceSpace slow to answer the file upload, as it is while it makes a video's previews. */
function slowUpload(ms: number) {
  const normal = h.rs.respond;
  h.rs.respond = (req: SeenRequest) => {
    const reply = normal(req);
    return req.url.includes("function=upload_multipart") ? { ...reply, delayMs: ms } : reply;
  };
}

describe("a dropped connection while a video is sending", () => {
  it("resumes from what the service already has, not from the start", async () => {
    h = await startHarness();
    h.auth.respond = member();
    proxy = await startProxy(h.url);
    const video = mp4(4 * MB);
    const chunkSize = MB;
    const submission = await client(h).startSubmission();

    // Partway through the fourth chunk, the phone loses its signal.
    proxy.dropAt = proxy.bytesUp + 3.5 * MB;
    const dropped = () => proxy!.dropAt === Infinity;
    const requests: { method: string; offset?: string }[] = [];
    let confirmedBeforeDrop = 0;
    let resumedFrom: number | undefined;
    const id = await new Promise<string>((resolve, reject) => {
      const u = new tus.Upload(video, {
        endpoint: `${proxy!.url}/upload/api/files/`,
        headers: { cookie: COOKIE },
        chunkSize,
        metadata: { submission, filename: "IMG_2043.MOV" },
        retryDelays: [50, 100, 200],
        storeFingerprintForResuming: false,
        onBeforeRequest: (req) => {
          requests.push({ method: req.getMethod(), offset: req.getHeader("Upload-Offset") ?? undefined });
        },
        onAfterResponse: (req, res) => {
          const offset = Number(res.getHeader("Upload-Offset"));
          if (req.getMethod() === "PATCH" && !dropped()) confirmedBeforeDrop = offset;
          if (req.getMethod() === "HEAD" && dropped() && resumedFrom === undefined) resumedFrom = offset;
        },
        onError: reject,
        onSuccess: () => resolve(u.url!.split("/").pop()!),
      });
      u.start();
    });

    expect(dropped()).toBe(true);
    // Three chunks were confirmed before the drop; the client asked the
    // service where it had got to and carried on from there.
    expect(confirmedBeforeDrop).toBe(3 * MB);
    expect(resumedFrom).toBeGreaterThanOrEqual(confirmedBeforeDrop);
    const afterDrop = requests.slice(requests.findIndex((r) => r.method === "HEAD"));
    expect(afterDrop[0]).toEqual({ method: "HEAD", offset: undefined });
    expect(afterDrop[1]).toEqual({ method: "PATCH", offset: String(resumedFrom) });
    // One upload, never started again.
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
    // Everything that went over the wire: the file once, plus at most the
    // chunk that was cut off (a restart would be well over 7 MB).
    expect(proxy.bytesUp).toBeLessThan(video.length + chunkSize);

    const res = await client(h).finish(id);
    expect(await res.json()).toEqual({ status: "sent" });
    const [item] = [...h.fakeRs.resources.values()];
    expect(item!.file!.data.equals(video)).toBe(true);
    expect(item!.resourceType).toBe(3);
  });

  it("resumes in a new connection after the old one is gone for good, as Try again does", async () => {
    h = await startHarness();
    h.auth.respond = member();
    proxy = await startProxy(h.url);
    const video = mov(3 * MB);
    const submission = await client(h).startSubmission();

    // The first attempt gives up (no retries) when the connection drops.
    proxy.dropAt = proxy.bytesUp + 1.5 * MB;
    let uploadUrl: string | null = null;
    await new Promise<void>((resolve) => {
      const u = new tus.Upload(video, {
        endpoint: `${proxy!.url}/upload/api/files/`,
        headers: { cookie: COOKIE },
        chunkSize: MB,
        metadata: { submission, filename: "IMG_2044.MOV" },
        retryDelays: [],
        storeFingerprintForResuming: false,
        onProgress: () => {
          uploadUrl = u.url;
        },
        onError: () => resolve(),
        onSuccess: () => resolve(),
      });
      u.start();
    });
    expect(uploadUrl).toBeTruthy();
    const id = uploadUrl!.split("/").pop()!;
    expect(await statusOf(id)).toEqual({ status: "incomplete" });

    // Try again: the same upload, from where the service got to.
    const patches: number[] = [];
    await new Promise<void>((resolve, reject) => {
      const u = new tus.Upload(video, {
        endpoint: `${h.url}/upload/api/files/`,
        uploadUrl: `${h.url}/upload/api/files/${id}`,
        headers: { cookie: COOKIE },
        chunkSize: MB,
        retryDelays: [],
        storeFingerprintForResuming: false,
        onBeforeRequest: (req) => {
          if (req.getMethod() === "PATCH") patches.push(Number(req.getHeader("Upload-Offset")));
        },
        onError: reject,
        onSuccess: () => resolve(),
      });
      u.start();
    });
    // Past the one chunk that was confirmed: what arrived of the cut chunk
    // was kept too, so even a link too slow to finish a chunk before Traefik
    // gives up on it keeps moving.
    expect(patches[0]).toBeGreaterThan(MB);
    expect(patches[0]).toBeLessThan(1.5 * MB);
    expect(await statusOf(id)).toEqual({ status: "arrived" });

    const res = await client(h).finish(id);
    expect(res.status).toBe(200);
    expect([...h.fakeRs.resources.values()][0]!.file!.data.equals(video)).toBe(true);
  });
});

describe("the Item's status, which the page polls", () => {
  it("is finishing while ResourceSpace works on a video, then sent", async () => {
    h = await startHarness({ HANDOFF_WAIT_MS: "50" });
    h.auth.respond = member();
    slowUpload(400);
    const id = await client(h).upload(mp4(), { metadata: { filename: "IMG_2043.MOV" } });

    // The page is not kept waiting: the service says it is finishing.
    const res = await client(h).finish(id);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "finishing" });
    expect(await statusOf(id)).toEqual({ status: "finishing" });

    expect(await settle(id)).toEqual({ status: "sent" });
    expect(h.fakeRs.resources.size).toBe(1);
    expect(await readdir(h.stagingDir)).toEqual([`${id}.item.json`]);
  });

  it("answers at once, as before, when ResourceSpace is quick", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const id = await client(h).upload(jpeg());

    const res = await client(h).finish(id);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "sent" });
    expect(await statusOf(id)).toEqual({ status: "sent" });
  });

  it("records the hand-off in the audit log when it ends, after the page stopped waiting", async () => {
    h = await startHarness({ HANDOFF_WAIT_MS: "50" });
    h.auth.respond = member();
    slowUpload(300);
    const id = await client(h).upload(mp4(), { metadata: { filename: "IMG_2043.MOV" } });

    await client(h).finish(id);
    await settle(id);

    const lines = h.auditLines.map((l) => JSON.parse(l)).filter((l) => l.uploadId === id && l.path === "/upload/api/items");
    expect(lines.map((l) => l.outcome)).toEqual(["finishing", "sent"]);
    expect(lines[1]).toMatchObject({ user: { id: "u-42" }, sizeBytes: 80_000, detectedType: "video/mp4" });
  });

  it("is incomplete while the file is still arriving, and arrived once it is all there", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const submission = await client(h).startSubmission();
    const create = await client(h).create(submission, 100);
    const id = create.headers.get("location")!.split("/").pop()!;

    expect(await statusOf(id)).toEqual({ status: "incomplete" });
    await fetch(`${h.url}/upload/api/files/${id}`, {
      method: "PATCH",
      headers: {
        cookie: COOKIE,
        "tus-resumable": "1.0.0",
        "upload-offset": "0",
        "content-type": "application/offset+octet-stream",
      },
      body: new Uint8Array(mp4(100)),
    });
    expect(await statusOf(id)).toEqual({ status: "arrived" });
  });

  it("is not_saved when ResourceSpace failed, and asking again finishes it with the same Item", async () => {
    h = await startHarness();
    h.auth.respond = member();
    h.fakeRs.failWhen = (c) => (c.fn === "upload_multipart" ? { status: 500, body: "boom" } : undefined);
    const id = await client(h).upload(mp4(), { metadata: { filename: "IMG_2043.MOV" } });

    expect((await client(h).finish(id)).status).toBe(502);
    expect(await statusOf(id)).toEqual({ status: "not_saved" });

    h.fakeRs.failWhen = () => undefined;
    expect((await client(h).finish(id)).status).toBe(200);
    expect(await statusOf(id)).toEqual({ status: "sent" });
    expect(h.fakeRs.calls.filter((c) => c.fn === "create_resource")).toHaveLength(1);
  });

  it("gives the reason when the file was refused, though nothing of it is left", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const id = await client(h).upload(Buffer.from("GIF89a" + "x".repeat(100)));

    expect((await client(h).finish(id)).status).toBe(415);

    expect(await readdir(h.stagingDir)).toEqual([]);
    expect(await statusOf(id)).toEqual({ status: "refused", error: "wrong_type" });
  });

  it("is only for the member who sent it", async () => {
    h = await startHarness({ HANDOFF_WAIT_MS: "50" });
    h.auth.respond = member();
    slowUpload(200);
    const id = await client(h).upload(mp4(), { metadata: { filename: "IMG_2043.MOV" } });
    await client(h).finish(id);

    h.auth.respond = signedInAs({ claims: ["member"], id: "someone-else" });
    const res = await status(id);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });

    h.auth.respond = member();
    expect(await settle(id)).toEqual({ status: "sent" });
    h.auth.respond = signedInAs({ claims: ["member"], id: "someone-else" });
    expect((await status(id)).status).toBe(404);
  });

  it("answers 404 for an unknown or malformed id", async () => {
    h = await startHarness();
    h.auth.respond = member();

    expect((await status("0".repeat(32))).status).toBe(404);
    expect((await status("..%2F..%2Fetc%2Fpasswd")).status).toBe(404);
  });

  it("needs a signed-in member", async () => {
    h = await startHarness();
    expect((await status("0".repeat(32), "")).status).toBe(401);
    h.auth.respond = signedInAs({ claims: [] });
    expect((await status("0".repeat(32))).status).toBe(403);
  });

  it("is only read: polling writes nothing to the audit log", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const id = await client(h).upload(jpeg());
    const before = h.auditLines.length;

    await status(id);
    await status(id);

    expect(h.auditLines.length).toBe(before);
  });
});

describe("the hand-off of a big video to ResourceSpace", () => {
  it("waits for ResourceSpace's previews longer than an ordinary API call may take", async () => {
    h = await startHarness({ RS_API_TIMEOUT_MS: "100", RS_UPLOAD_TIMEOUT_MS: "5000", HANDOFF_WAIT_MS: "50" });
    h.auth.respond = member();
    slowUpload(500);
    const id = await client(h).upload(mp4(), { metadata: { filename: "IMG_2043.MOV" } });

    expect((await client(h).finish(id)).status).toBe(202);
    expect(await settle(id)).toEqual({ status: "sent" });
  });

  it("gives up when ResourceSpace takes too long, and trying again keeps the one Item", async () => {
    h = await startHarness({ RS_UPLOAD_TIMEOUT_MS: "150", HANDOFF_WAIT_MS: "50" });
    h.auth.respond = member();
    slowUpload(600);
    const id = await client(h).upload(mp4(), { metadata: { filename: "IMG_2043.MOV" } });

    expect((await client(h).finish(id)).status).toBe(202);
    expect(await settle(id)).toEqual({ status: "not_saved" });

    h.rs.respond = (req) => (req.url.startsWith("/api/") ? h.fakeRs.handle(req) : { body: "" });
    expect((await client(h).finish(id)).status).toBe(200);
    expect(h.fakeRs.resources.size).toBe(1);
    expect(h.fakeRs.calls.filter((c) => c.fn === "upload_multipart")).toHaveLength(2);
  });

  it(
    "streams a 1 GB video, at the limit, to ResourceSpace in one request, byte for byte",
    async () => {
      const rs = await startStreamingResourceSpace();
      cleanups.push(rs.close);
      h = await startHarness({ RS_BASE_URL: rs.url });
      h.auth.respond = member();

      // A sparse file: an MP4 header, then zeros, exactly 1 GiB.
      const work = await mkdtemp(path.join(tmpdir(), "upload-big-"));
      cleanups.push(() => rm(work, { recursive: true, force: true }));
      const source = path.join(work, "IMG_9999.MOV");
      const fh = await open(source, "w");
      await fh.write(mp4(32));
      await fh.truncate(GiB);
      await fh.close();
      const expected = await sha256Of(source);

      const submission = await client(h).startSubmission();
      const id = await new Promise<string>((resolve, reject) => {
        const u = new tus.Upload(createReadStream(source), {
          endpoint: `${h.url}/upload/api/files/`,
          headers: { cookie: COOKIE },
          chunkSize: 64 * MB,
          uploadSize: GiB,
          metadata: { submission, filename: "IMG_9999.MOV" },
          retryDelays: [],
          storeFingerprintForResuming: false,
          onError: reject,
          onSuccess: () => resolve(u.url!.split("/").pop()!),
        });
        u.start();
      });

      const res = await client(h).finish(id);
      if (res.status === 202) expect(await settle(id)).toEqual({ status: "sent" });
      else expect(res.status).toBe(200);

      expect(rs.uploads).toHaveLength(1);
      const [up] = rs.uploads;
      expect(up!.fileBytes).toBe(GiB);
      expect(up!.sha256).toBe(expected);
      expect(up!.contentLength).toBe(up!.headBytes + GiB + up!.tailBytes);
      expect(up!.contentType).toBe("video/mp4");
      // Nothing of it is left on the staging volume, only the small record.
      expect(await readdir(h.stagingDir)).toEqual([`${id}.item.json`]);
    },
    120_000,
  );
});

describe("staging", () => {
  it("is the only place the service writes", async () => {
    h = await startHarness({ HANDOFF_WAIT_MS: "50" });
    h.auth.respond = member();
    const work = path.dirname(h.stagingDir);
    const before = await tree(work);

    const submission = await client(h).startSubmission();
    const ids = [await client(h).upload(mp4(2 * MB), { submission, metadata: { filename: "a.mov" } }), await client(h).upload(jpeg(), { submission })];
    const midway = await readdir(h.stagingDir);
    for (const id of ids) await client(h).finish(id);
    for (const id of ids) await settle(id);

    const after = await tree(work);
    const outside = (t: string[]) => t.filter((p) => !p.startsWith("staging/"));
    expect(outside(after)).toEqual(outside(before));
    // While arriving: the bytes and tus's record of them, under server-made ids.
    expect(midway.sort()).toEqual(ids.flatMap((id) => [id, `${id}.json`]).sort());
    // Once sent: only each Item's small record.
    expect((await readdir(h.stagingDir)).sort()).toEqual(ids.map((id) => `${id}.item.json`).sort());
  });
});

/** Every path under `dir`, relative to it. */
async function tree(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries.map((e) => e.split(path.sep).join("/")).sort();
}

function sha256Of(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (c) => hash.update(c))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

interface StreamedUpload {
  contentLength: number;
  contentType: string | undefined;
  headBytes: number;
  tailBytes: number;
  fileBytes: number;
  sha256: string;
}

/**
 * A ResourceSpace that takes the file upload as a stream and keeps only its
 * size and hash, so a 1 GB test never holds 1 GB in memory. Answers the
 * other calls as the real one does when they succeed.
 */
async function startStreamingResourceSpace() {
  const uploads: StreamedUpload[] = [];
  const server = http.createServer((req, res) => {
    const fn = new URL(req.url ?? "/", "http://rs").searchParams.get("function");
    if (fn !== "upload_multipart") {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(fn === "create_resource" ? "5000" : "true");
      return;
    }
    const boundary = /boundary=([^;]+)/.exec(req.headers["content-type"] ?? "")?.[1] ?? "";
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const hash = createHash("sha256");
    let head = Buffer.alloc(0);
    let headBytes = -1;
    let contentType: string | undefined;
    let held = Buffer.alloc(0);
    let fileBytes = 0;
    const take = (data: Buffer) => {
      // Hold back what may be the closing boundary.
      const all = Buffer.concat([held, data]);
      const keep = Math.min(all.length, tail.length);
      const out = all.subarray(0, all.length - keep);
      hash.update(out);
      fileBytes += out.length;
      held = Buffer.from(all.subarray(all.length - keep));
    };
    req.on("data", (chunk: Buffer) => {
      if (headBytes >= 0) return take(chunk);
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      headBytes = end + 4;
      contentType = /content-type:\s*([^\r\n]+)/i.exec(head.subarray(0, end).toString())?.[1];
      take(head.subarray(headBytes));
    });
    req.on("end", () => {
      const ok = held.equals(tail);
      uploads.push({
        contentLength: Number(req.headers["content-length"]),
        contentType,
        headBytes,
        tailBytes: tail.length,
        fileBytes,
        sha256: hash.digest("hex"),
      });
      res.writeHead(ok ? 204 : 400);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    uploads,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
