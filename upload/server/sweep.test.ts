// Seam 1: keeping staging clean (#23, #60). Abandoned uploads are swept 24
// hours after their last chunk, leftovers are removed at startup, and
// nothing a member could still resume, try again or ask about is ever
// removed early. A file's age is set on the file itself (its last chunk was
// that long ago); the clock is moved on only where the service's own memory
// is what counts.
import { mkdir, readdir, readFile, stat, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ANSWERS, client, jpeg, member, mp4 } from "./testing/client.ts";
import { COOKIE, startHarness, type Harness } from "./testing/harness.ts";

let h: Harness;
afterEach(async () => h?.close());

const HOUR = 60 * 60 * 1000;

/** Makes these files on staging look `hours` old. */
async function age(hours: number, ...names: string[]) {
  const when = new Date(Date.now() - hours * HOUR);
  for (const name of names) await utimes(path.join(h.stagingDir, name), when, when);
}

/** Every file and record of one upload. */
async function filesOf(id: string) {
  return (await readdir(h.stagingDir)).filter((n) => n.startsWith(id)).sort();
}

function patch(id: string, offset: number, body: Buffer) {
  return fetch(`${h.url}/upload/api/files/${id}`, {
    method: "PATCH",
    headers: {
      cookie: COOKIE,
      "tus-resumable": "1.0.0",
      "upload-offset": String(offset),
      "content-type": "application/offset+octet-stream",
    },
    body: new Uint8Array(body),
  });
}

/** An upload of `file` that stopped partway, after `sent` bytes: the phone gave up. */
async function halfSent(file: Buffer, sent: number, submission?: string) {
  const s = submission ?? (await client(h).startSubmission());
  const res = await client(h).create(s, file.length);
  const id = res.headers.get("location")!.split("/").pop()!;
  expect((await patch(id, 0, file.subarray(0, sent))).status).toBe(204);
  return { id, submission: s };
}

const statusOf = async (id: string) => {
  const res = await fetch(`${h.url}/upload/api/items/${id}`, { headers: { cookie: COOKIE } });
  return res.status === 404 ? 404 : res.json();
};

describe("an upload the member stopped sending", () => {
  it("is kept, and can be finished, for 24 hours after its last chunk", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const video = mp4(200_000);
    const { id } = await halfSent(video, 80_000);
    await age(23, id, `${id}.json`);

    await h.sweep();

    expect(await filesOf(id)).toEqual([id, `${id}.json`]);
    expect((await patch(id, 80_000, video.subarray(80_000))).status).toBe(204);
    expect((await client(h).finish(id)).status).toBe(200);
  });

  it("is removed once 24 hours have passed without a chunk, and its room given back", async () => {
    h = await startHarness({ QUOTA_STAGED_BYTES: "250000" });
    h.auth.respond = member();
    const { id } = await halfSent(mp4(200_000), 120_000);
    const next = await client(h).startSubmission();
    expect((await client(h).create(next, 150_000)).status).toBe(429);
    await age(25, id, `${id}.json`);

    const report = await h.sweep();

    expect(report.removed.sort()).toEqual([id, `${id}.json`]);
    expect(await filesOf(id)).toEqual([]);
    expect(await statusOf(id)).toBe(404);
    expect((await client(h).create(next, 150_000)).status).toBe(201);
  });

  it("is removed too once it arrived but was never handed over", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const id = await client(h).upload(jpeg());
    expect(await statusOf(id)).toEqual({ status: "arrived" });
    await age(25, id, `${id}.json`);

    await h.sweep();

    expect(await filesOf(id)).toEqual([]);
  });
});

describe("a hand-off that ResourceSpace did not finish", () => {
  async function notSaved() {
    h = await startHarness();
    h.auth.respond = member();
    h.fakeRs.failWhen = (c) => (c.fn === "upload_multipart" ? { status: 500, body: "boom" } : undefined);
    const id = await client(h).upload(mp4(), { metadata: { filename: "IMG_2043.MOV" } });
    expect((await client(h).finish(id)).status).toBe(502);
    h.fakeRs.failWhen = () => undefined;
    return id;
  }

  it("is kept for 24 hours, so Try again finishes it with the same Item", async () => {
    const id = await notSaved();
    await age(23, id, `${id}.json`, `${id}.item.json`);

    await h.sweep();

    expect(await filesOf(id)).toEqual([id, `${id}.item.json`, `${id}.json`]);
    expect((await client(h).finish(id)).status).toBe(200);
    expect(h.fakeRs.calls.filter((c) => c.fn === "create_resource")).toHaveLength(1);
  });

  it("is removed after that, and its ResourceSpace ref logged for a Reviewer to clear", async () => {
    const id = await notSaved();
    const ref = JSON.parse(await readFile(path.join(h.stagingDir, `${id}.item.json`), "utf8")).ref as number;
    await age(25, id, `${id}.json`, `${id}.item.json`);

    await h.sweep();

    expect(await filesOf(id)).toEqual([]);
    expect(h.logLines).toContainEqual(expect.objectContaining({ fields: expect.objectContaining({ uploadId: id, ref }) }));
  });
});

describe("the record of a sent Item", () => {
  it("is kept for 24 hours, so asking again still answers sent", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const id = await client(h).upload(jpeg());
    await client(h).finish(id);
    await age(23, `${id}.item.json`);

    await h.sweep();

    expect(await statusOf(id)).toEqual({ status: "sent" });
    expect(await (await client(h).finish(id)).json()).toEqual({ status: "sent" });
  });

  it("is removed after 24 hours", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const id = await client(h).upload(jpeg());
    await client(h).finish(id);
    await age(25, `${id}.item.json`);

    await h.sweep();

    expect(await filesOf(id)).toEqual([]);
  });
});

describe("a Submission's record", () => {
  const record = (id: string) => `${id}.submission.json`;
  const has = async (id: string) => (await readdir(h.stagingDir)).includes(record(id));

  it("is kept while an upload on staging belongs to it, however old it is", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const { id, submission } = await halfSent(mp4(200_000), 50_000);
    await age(30, record(submission));
    // A restart: the service no longer remembers the Submission, only the upload says it is wanted.
    await h.restart();

    await h.sweep();

    expect(await has(submission)).toBe(true);
    // The upload still hands over with the answers from it.
    await patch(id, 50_000, mp4(200_000).subarray(50_000));
    expect((await client(h).finish(id)).status).toBe(200);
  });

  it("is kept while the Submission is still taking uploads", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const submission = await client(h).startSubmission();
    await age(25, record(submission));

    await h.sweep();
    expect(await has(submission)).toBe(true);

    // A day after anything was last added to it, it is forgotten, and so is its record.
    h.advance(25 * HOUR);
    await h.sweep();
    expect(await has(submission)).toBe(false);
  });

  it("is kept for 24 hours after it was started", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const submission = await client(h).startSubmission();
    await h.restart();
    await age(23, record(submission));

    await h.sweep();
    expect(await has(submission)).toBe(true);

    await age(25, record(submission));
    await h.sweep();
    expect(await has(submission)).toBe(false);
  });
});

describe("at startup", () => {
  it("removes leftovers at once, keeps what can still be resumed, and counts it against its member again", async () => {
    h = await startHarness({ QUOTA_STAGED_BYTES: "250000" });
    h.auth.respond = member();
    const video = mp4(200_000);
    const { id: resumable, submission } = await halfSent(video, 150_000);
    const half = "a".repeat(32);
    const otherHalf = "b".repeat(32);
    const notOurs = "c".repeat(32);
    await writeFile(path.join(h.stagingDir, half), "bytes without tus's record");
    await writeFile(path.join(h.stagingDir, `${otherHalf}.json`), JSON.stringify({ id: otherHalf, size: 10, metadata: {} }));
    await writeFile(path.join(h.stagingDir, notOurs), "x");
    await writeFile(path.join(h.stagingDir, `${notOurs}.json`), JSON.stringify({ id: notOurs, size: 1, metadata: { owner: "u-42" } }));
    await writeFile(path.join(h.stagingDir, `${"d".repeat(32)}.item.json.tmp`), "{");
    await writeFile(path.join(h.stagingDir, "abcdefghjkmn.submission.json.tmp"), "{");

    await h.restart();

    expect((await readdir(h.stagingDir)).sort()).toEqual(
      [resumable, `${resumable}.json`, `${submission}.submission.json`].sort(),
    );
    // The member's 150 000 bytes still count: 150 000 more do not fit...
    const next = await client(h).startSubmission();
    expect((await client(h).create(next, 150_000)).status).toBe(429);
    // ...and the upload carries on where it stopped, and hands over.
    expect((await patch(resumable, 150_000, video.subarray(150_000))).status).toBe(204);
    expect((await client(h).finish(resumable)).status).toBe(200);
    expect((await client(h).create(next, 150_000)).status).toBe(201);
  });

  it("keeps the records a retry or a status poll still needs", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const sent = await client(h).upload(jpeg());
    await client(h).finish(sent);

    await h.restart();

    expect(await statusOf(sent)).toEqual({ status: "sent" });
  });

  it("removes what was abandoned while the service was down", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const { id } = await halfSent(mp4(200_000), 50_000);
    await age(25, id, `${id}.json`);

    await h.restart();

    expect(await filesOf(id)).toEqual([]);
  });
});

describe("while running", () => {
  it("leaves a fresh half-made upload alone (one being created has two halves for a moment), and removes it once an hour old", async () => {
    h = await startHarness();
    const id = "e".repeat(32);
    await writeFile(path.join(h.stagingDir, id), "");

    await h.sweep();
    expect(await filesOf(id)).toEqual([id]);

    await age(2, id);
    await h.sweep();
    expect(await filesOf(id)).toEqual([]);
  });
});

describe("the sweep", () => {
  it("touches nothing it did not make, inside staging or out", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const work = path.dirname(h.stagingDir);
    const outside = path.join(work, "secret.txt");
    // Things on staging the service never makes: a stray file, a directory
    // (the volume's lost+found), and a link named like an upload that points out.
    await writeFile(path.join(h.stagingDir, "notes.txt"), "keep me");
    await mkdir(path.join(h.stagingDir, "lost+found"));
    const link = "f".repeat(32);
    await symlink(outside, path.join(h.stagingDir, link));
    await symlink(outside, path.join(h.stagingDir, `${link}.json`));
    const old = new Date(Date.now() - 48 * HOUR);
    await utimes(outside, old, old);
    const before = await stat(outside);

    await h.restart();
    await h.sweep();

    const left = await readdir(h.stagingDir);
    expect(left).toEqual(expect.arrayContaining(["notes.txt", "lost+found", link, `${link}.json`]));
    expect(await readFile(outside, "utf8")).toBe("outside the web root");
    expect((await stat(outside)).mtimeMs).toBe(before.mtimeMs);
  });

  it("runs alongside uploads without disturbing them", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const c = client(h);
    const submission = await c.startSubmission(COOKIE, { expectedItems: 3, details: ANSWERS, rightsConfirmed: true });

    const sending = Promise.all([c.upload(mp4(300_000), { submission, chunkSize: 50_000 }), c.upload(jpeg(), { submission })]);
    const sweeps = Promise.all([h.sweep(), h.sweep(), h.sweep()]);
    const [ids, reports] = await Promise.all([sending, sweeps]);

    expect(reports.flatMap((r) => r.removed)).toEqual([]);
    for (const id of ids) expect((await c.finish(id)).status).toBe(200);
  });
});
