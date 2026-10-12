// Seam 1: many photos and videos in one Submission (#54), through the
// service's HTTP boundary. The service enforces the decided limits (#18) by
// content, whatever the page did: the types it takes, the size of each file,
// and the number of Items, videos and bytes per Submission. Each refusal has
// its own reason, and the rest of the Submission carries on.
import { readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { client, heic, jpeg, member, mov, mp4, png } from "./testing/client.ts";
import { COOKIE, signedInAs, startHarness, type Harness } from "./testing/harness.ts";

let h: Harness;
afterEach(async () => h?.close());

/** Bytes that start like a type we do not take, then filler. */
function other(magic: string, size = 20_000): Buffer {
  const b = Buffer.alloc(size, 9);
  b.write(magic, 0, "latin1");
  return b;
}

/** The staged files that are bytes (not the small records beside them). */
async function stagedBytes(): Promise<string[]> {
  return (await readdir(h.stagingDir)).filter((f) => /^[0-9a-f]{32}$/.test(f));
}

/** Everything in staging besides the Submissions' small records. */
async function staged(): Promise<string[]> {
  return (await readdir(h.stagingDir)).filter((f) => !f.endsWith(".submission.json"));
}

/** The ResourceSpace calls that change something (reading the choices does not). */
const writes = () => h.fakeRs.calls.filter((c) => !c.fn.startsWith("get_"));

const items = () => [...h.fakeRs.resources.values()];

describe("starting a Submission", () => {
  it("gives the member a new id each time", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const c = client(h);

    const a = await c.startSubmission();
    const b = await c.startSubmission();

    expect(a).toMatch(/^[a-z0-9]{12}$/);
    expect(b).not.toBe(a);
  });

  it("takes only a JSON request, so another site cannot start one", async () => {
    h = await startHarness();
    h.auth.respond = member();

    const res = await fetch(`${h.url}/upload/api/submissions`, {
      method: "POST",
      headers: { cookie: COOKIE, "content-type": "application/x-www-form-urlencoded" },
      body: "a=1",
    });

    expect(res.status).toBe(415);
  });

  it("needs a signed-in member", async () => {
    h = await startHarness();

    const res = await fetch(`${h.url}/upload/api/submissions`, {
      method: "POST",
      headers: { cookie: COOKIE, "content-type": "application/json" },
      body: "{}",
    });

    expect(res.status).toBe(401);
  });
});

describe("sending many photos and videos at once", () => {
  it("lands each as its own Item, all under one Submission ID, numbered in turn", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const c = client(h);
    const submission = await c.startSubmission();
    const files = [jpeg(), heic(), png(), mp4(), mov()];

    for (const data of files) {
      const res = await c.finish(await c.upload(data, { submission }));
      expect(res.status).toBe(200);
    }

    const all = items();
    expect(all).toHaveLength(5);
    expect(new Set(all.map((i) => i.fields.submissionid))).toEqual(new Set([submission]));
    const code = submission.slice(0, 6);
    expect(all.map((i) => i.file?.name)).toEqual([
      `dovetail-class-may-3_${code}-001.jpg`,
      `dovetail-class-may-3_${code}-002.heic`,
      `dovetail-class-may-3_${code}-003.png`,
      `dovetail-class-may-3_${code}-004.mp4`,
      `dovetail-class-may-3_${code}-005.mov`,
    ]);
    expect(all.every((i) => i.archive === -1)).toBe(true);
  });

  it("stores videos as Videos and photos as Photos in ResourceSpace", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const c = client(h);
    const submission = await c.startSubmission();

    await c.finish(await c.upload(jpeg(), { submission }));
    await c.finish(await c.upload(mp4(), { submission, metadata: { filename: "clip.mp4" } }));
    await c.finish(await c.upload(mov(), { submission, metadata: { filename: "IMG_2043.MOV" } }));

    expect(items().map((i) => [i.resourceType, i.file?.contentType])).toEqual([
      [1, "image/jpeg"],
      [3, "video/mp4"],
      [3, "video/quicktime"],
    ]);
  });

  it("takes two at once into the same Submission, giving each its own number", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const c = client(h);
    const submission = await c.startSubmission();

    // Two at a time, as the page sends them (a member may have no more going at once, #60).
    const ids = [
      ...(await Promise.all([jpeg(), png()].map((d) => c.upload(d, { submission })))),
      ...(await Promise.all([heic(), mp4()].map((d) => c.upload(d, { submission })))),
    ];
    for (const id of ids) expect((await c.finish(id)).status).toBe(200);

    const numbers = items().map((i) => /-(\d{3})\.\w+$/.exec(i.file!.name)![1]).sort();
    expect(numbers).toEqual(["001", "002", "003", "004"]);
  });
});

describe("each file is checked by its content, not its name", () => {
  it.each([
    ["a GIF named like a photo", other("GIF89a"), "IMG_0001.JPG"],
    ["a PDF named like a photo", other("%PDF-1.7"), "scan.heic"],
    ["a zip named like a video", other("PK\x03\x04"), "IMG_2043.MOV"],
    ["audio named like a video", other("\x00\x00\x00\x20ftypM4A "), "voice.mp4"],
    ["an AVIF photo (not one we take)", other("\x00\x00\x00\x1cftypavif"), "photo.png"],
    ["a WebP photo", other("RIFF\x00\x00\x00\x00WEBPVP8 "), "photo.jpg"],
  ])("refuses %s, and removes it", async (_name, data, filename) => {
    h = await startHarness();
    h.auth.respond = member();
    const c = client(h);

    const id = await c.upload(data, { metadata: { filename, filetype: "image/jpeg" } });
    const res = await c.finish(id);

    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: "wrong_type" });
    expect(writes()).toHaveLength(0);
    expect(await stagedBytes()).toEqual([]);
  });

  it("names a photo by what it is, even when its name says otherwise", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const c = client(h);

    await c.finish(await c.upload(png(), { metadata: { filename: "holiday.mov", filetype: "video/quicktime" } }));

    const [item] = items();
    expect(item!.resourceType).toBe(1);
    expect(item!.file?.name).toMatch(/\.png$/);
    expect(item!.fields.submitterfilename).toBe("holiday.mov");
  });
});

describe("each limit has its own reason, and the rest of the Submission carries on", () => {
  it("too big: a photo over the photo limit, though a video that size would be fine", async () => {
    h = await startHarness({ PHOTO_MAX_BYTES: "100000" });
    h.auth.respond = member();
    const c = client(h);
    const submission = await c.startSubmission();

    const big = await c.finish(await c.upload(jpeg(100_001), { submission }));
    const video = await c.finish(await c.upload(mp4(100_001), { submission }));
    const small = await c.finish(await c.upload(jpeg(100_000), { submission }));

    expect([big.status, video.status, small.status]).toEqual([413, 200, 200]);
    expect(await big.json()).toEqual({ error: "too_big" });
    expect(items()).toHaveLength(2);
  });

  it("too big: a video over the video limit, refused before anything is stored", async () => {
    h = await startHarness({ VIDEO_MAX_BYTES: "200000" });
    h.auth.respond = member();
    const c = client(h);
    const submission = await c.startSubmission();

    const res = await c.create(submission, 200_001);

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "too_big" });
    expect(await staged()).toEqual([]);
    expect((await c.finish(await c.upload(mp4(200_000), { submission }))).status).toBe(200);
  });

  it("too many: more Items than one Submission takes", async () => {
    h = await startHarness({ SUBMISSION_MAX_ITEMS: "2" });
    h.auth.respond = member();
    const c = client(h);
    const submission = await c.startSubmission();
    const first = await c.upload(jpeg(), { submission });
    const second = await c.upload(png(), { submission });

    const third = await c.create(submission, 1000);

    expect(third.status).toBe(422);
    expect(await third.json()).toEqual({ error: "too_many" });
    expect((await c.finish(first)).status).toBe(200);
    expect((await c.finish(second)).status).toBe(200);
    expect(items()).toHaveLength(2);
  });

  it("too many videos: more videos than one Submission takes, while photos still fit", async () => {
    h = await startHarness({ SUBMISSION_MAX_VIDEOS: "1" });
    h.auth.respond = member();
    const c = client(h);
    const submission = await c.startSubmission();
    const video1 = await c.upload(mp4(), { submission });
    const video2 = await c.upload(mov(), { submission });
    const photo = await c.upload(jpeg(), { submission });

    const results = [await c.finish(video1), await c.finish(video2), await c.finish(photo)];

    expect(results.map((r) => r.status)).toEqual([200, 422, 200]);
    expect(await results[1]!.json()).toEqual({ error: "too_many_videos" });
    expect(items().map((i) => i.resourceType)).toEqual([3, 1]);
    expect(await stagedBytes()).toEqual([]);
  });

  it("too much in all: more bytes than one Submission takes", async () => {
    h = await startHarness({ SUBMISSION_MAX_BYTES: "250000" });
    h.auth.respond = member();
    const c = client(h);
    const submission = await c.startSubmission();
    const first = await c.upload(jpeg(200_000), { submission });

    const over = await c.create(submission, 50_001);
    const fits = await c.upload(png(50_000), { submission });

    expect(over.status).toBe(413);
    expect(await over.json()).toEqual({ error: "too_much_in_all" });
    expect((await c.finish(first)).status).toBe(200);
    expect((await c.finish(fits)).status).toBe(200);
  });

  it("the reasons are all different", async () => {
    const { REFUSAL_STATUS } = await import("./uploads.ts");
    const reasons = Object.keys(REFUSAL_STATUS);
    expect(new Set(reasons).size).toBe(7);
    expect(reasons.sort()).toEqual([
      "too_big",
      "too_many",
      "too_many_today",
      "too_many_videos",
      "too_much_in_all",
      "too_much_today",
      "wrong_type",
    ]);
  });

  it("a refused file gives its room back", async () => {
    h = await startHarness({ SUBMISSION_MAX_ITEMS: "1" });
    h.auth.respond = member();
    const c = client(h);
    const submission = await c.startSubmission();

    const wrong = await c.finish(await c.upload(other("GIF89a"), { submission }));
    const right = await c.finish(await c.upload(jpeg(), { submission }));

    expect([wrong.status, right.status]).toEqual([415, 200]);
  });

  it("a file the member took out before it was handed over gives its room back", async () => {
    h = await startHarness({ SUBMISSION_MAX_ITEMS: "1" });
    h.auth.respond = member();
    const c = client(h);
    const submission = await c.startSubmission();
    const created = await c.create(submission, 1000);
    expect((await c.create(submission, 1000)).status).toBe(422);

    const del = await fetch(new URL(created.headers.get("location")!, h.url), {
      method: "DELETE",
      headers: { cookie: COOKIE, "tus-resumable": "1.0.0" },
    });

    expect(del.status).toBe(204);
    expect((await c.create(submission, 1000)).status).toBe(201);
  });

  it("writes the refusal and the detected type to the audit log", async () => {
    h = await startHarness({ SUBMISSION_MAX_VIDEOS: "0" });
    h.auth.respond = member();
    const c = client(h);

    const id = await c.upload(mov());
    await c.finish(id);

    const line = h.auditLines.map((l) => JSON.parse(l)).find((l) => l.uploadId === id && l.outcome !== "created");
    expect(line).toMatchObject({ outcome: "too_many_videos", detectedType: "video/quicktime", sizeBytes: 80_000 });
  });
});

describe("a Submission belongs to the member who started it", () => {
  it("nobody else can send into it", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const c = client(h);
    const submission = await c.startSubmission();

    h.auth.respond = signedInAs({ claims: ["member"], id: "u-99" });
    const res = await c.create(submission, 1000);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(await staged()).toEqual([]);
  });

  it.each([
    ["an id the service never gave", "abcdefghjkmn"],
    ["no id at all", ""],
  ])("refuses an upload with %s", async (_name, submission) => {
    h = await startHarness();
    h.auth.respond = member();

    const res = await client(h).create(submission, 1000);

    expect(res.status).toBe(404);
    expect(await staged()).toEqual([]);
  });
});

describe("the names the member's device gives files", () => {
  it.each([
    ["a path that climbs out", "../../../../etc/passwd", "passwd"],
    ["a Windows path", "..\\..\\Windows\\System32\\evil.jpg", "evil.jpg"],
    ["an absolute path", "/var/www/html/filestore/x.php", "x.php"],
    ["Unicode", "Ünïcødé 写真 🎉.JPG", "Ünïcødé 写真 🎉.JPG"],
    ["a decomposed accent and a right-to-left mark", "Café ‮gpj.mov", "Café ‮gpj.mov"],
    ["control characters", "a\u0000b\nc\u007f.jpg", "abc.jpg"],
    ["a name that is only dots", "..", ".."],
  ])("are never used to store anything: %s", async (_name, filename, kept) => {
    h = await startHarness();
    h.auth.respond = member();
    const c = client(h);
    const parent = path.dirname(h.stagingDir);
    const before = await readdir(parent);

    const id = await c.upload(jpeg(), { metadata: { filename, filetype: "image/jpeg" } });
    const files = await staged();
    const res = await c.finish(id);

    // On disk: only the server's own id, inside staging, and nothing beside it.
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(files.every((f) => f.startsWith(id))).toBe(true);
    expect(await readdir(parent)).toEqual(before);
    // In ResourceSpace: the File name is the service's own; the device's name
    // is kept only as text, without any path.
    expect(res.status).toBe(200);
    const [item] = items();
    expect(item!.file?.name).toMatch(/^dovetail-class-may-3_[a-z0-9]{6}-001\.jpg$/);
    expect(item!.fields.submitterfilename).toBe(kept);
  });
});
