// Seam 1: sending one photo, end to end through the service's HTTP boundary.
// The photo goes up over tus (driven by tus-js-client, the library under
// Uppy's tus plugin), then the page asks the service to hand it to
// ResourceSpace. Auth and ResourceSpace are fakes (testing/harness.ts,
// testing/fake-rs.ts).
import { readdir } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import * as tus from "tus-js-client";
import { FAKE_RS_KEY } from "./testing/fake-rs.ts";
import { COOKIE, signedInAs, startHarness, type Harness } from "./testing/harness.ts";

let h: Harness;
afterEach(async () => h?.close());

const RIGHTS = 'I took these, or I have permission to share them with SDFWA';

/** A small but real-looking JPEG: the magic bytes, then filler. */
function jpeg(size = 300_000): Buffer {
  const b = Buffer.alloc(size, 7);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
  return b;
}

function heic(size = 50_000): Buffer {
  const b = Buffer.alloc(size, 3);
  b.set([0x00, 0x00, 0x00, 0x18]);
  b.write("ftypheic", 4, "latin1");
  return b;
}

function png(size = 20_000): Buffer {
  const b = Buffer.alloc(size, 1);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return b;
}

interface SendOptions {
  cookie?: string;
  metadata?: Record<string, string>;
  chunkSize?: number;
}

/** Uploads over tus as the page does; resolves with the upload's id. */
function upload(data: Buffer, opts: SendOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new tus.Upload(data, {
      endpoint: `${h.url}/upload/api/files/`,
      headers: { cookie: opts.cookie ?? COOKIE },
      chunkSize: opts.chunkSize ?? 100_000,
      metadata: opts.metadata ?? { filename: "IMG_4821.JPG", filetype: "image/jpeg" },
      retryDelays: [],
      storeFingerprintForResuming: false,
      onError: reject,
      onSuccess: () => resolve(u.url!.split("/").pop()!),
    });
    u.start();
  });
}

function finish(uploadId: string, body: Record<string, unknown> = {}, cookie = COOKIE) {
  return fetch(`${h.url}/upload/api/items`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ uploadId, title: "Dovetail class, May 3", rightsConfirmed: true, ...body }),
  });
}

function member(extra: Partial<Parameters<typeof signedInAs>[0]> = {}) {
  return signedInAs({
    claims: ["member"],
    id: "u-42",
    email: "pat@example.org",
    memberId: "M-1234",
    name: "Pat Member",
    ...extra,
  });
}

const only = <T>(m: Map<number, T>): T => {
  expect(m.size).toBe(1);
  return [...m.values()][0]!;
};

describe("sending one photo", () => {
  it("lands one Item in Pending Review with the Title and all six Submitter fields", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const photo = jpeg();

    const id = await upload(photo);
    const res = await finish(id);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "sent" });
    const item = only(h.fakeRs.resources);
    expect(item.archive).toBe(-1);
    expect(item.resourceType).toBe(1);
    expect(item.file?.data.equals(photo)).toBe(true);
    expect(item.fields).toEqual({
      title: "Dovetail class, May 3",
      submittername: "Pat Member",
      submitteremail: "pat@example.org",
      submittermemberid: "M-1234",
      submissionid: expect.stringMatching(/^[a-z0-9]{12}$/),
      submitterrights: expect.stringMatching(
        new RegExp(`^Confirmed \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} PT: "${RIGHTS}"$`),
      ),
      submitterfilename: "IMG_4821.JPG",
    });
  });

  it("asks for Pending Review explicitly, never the default state", async () => {
    h = await startHarness();
    h.auth.respond = member();

    await finish(await upload(jpeg()));

    const create = h.fakeRs.calls.find((c) => c.fn === "create_resource")!;
    expect(create.params.get("archive")).toBe("-1");
  });

  it("lets ResourceSpace read the photo's own metadata (such as the date it was taken)", async () => {
    h = await startHarness();
    h.auth.respond = member();

    await finish(await upload(jpeg()));

    const up = h.fakeRs.calls.find((c) => c.fn === "upload_multipart")!;
    expect(up.params.get("no_exif")).toBe("");
  });

  it("asks ResourceSpace to turn the photo upright from its camera orientation", async () => {
    h = await startHarness();
    h.auth.respond = member();

    await finish(await upload(jpeg()));

    const up = h.fakeRs.calls.find((c) => c.fn === "upload_multipart")!;
    expect(up.params.get("autorotate")).toBe("1");
  });

  it("names the file date-less slug, Submission code and Item number, with the detected extension", async () => {
    h = await startHarness();
    h.auth.respond = member();

    await finish(await upload(jpeg(), { metadata: { filename: "IMG_4821.HEIC" } }));

    const item = only(h.fakeRs.resources);
    const code = item.fields.submissionid!.slice(0, 6);
    // The extension comes from the content (a JPEG), not the name the phone gave it.
    expect(item.file?.name).toBe(`dovetail-class-may-3_${code}-001.jpg`);
    expect(item.fields.submitterfilename).toBe("IMG_4821.HEIC");
  });

  it.each([
    ["HEIC", heic(), "heic"],
    ["PNG", png(), "png"],
  ])("accepts a %s photo", async (_kind, data, ext) => {
    h = await startHarness();
    h.auth.respond = member();

    const res = await finish(await upload(data));

    expect(res.status).toBe(200);
    expect(only(h.fakeRs.resources).file?.name).toMatch(new RegExp(`-001\\.${ext}$`));
  });

  it("writes the Title exactly as typed", async () => {
    h = await startHarness();
    h.auth.respond = member();

    await finish(await upload(jpeg()), { title: "  Pat's café: dovetails & joints — May 3  " });

    const item = only(h.fakeRs.resources);
    expect(item.fields.title).toBe("Pat's café: dovetails & joints — May 3");
    expect(item.file?.name).toMatch(/^pats-cafe-dovetails-joints-may-3_[a-z0-9]{6}-001\.jpg$/);
  });

  it("signs every call as the upload-service user and goes straight to ResourceSpace with the public Host", async () => {
    h = await startHarness();
    h.auth.respond = member();

    await finish(await upload(jpeg()));

    expect(h.fakeRs.calls.map((c) => c.fn)).toEqual([
      "create_resource",
      "upload_multipart",
      ...Array(7).fill("update_field"),
    ]);
    for (const c of h.fakeRs.calls) {
      expect(c.headers.host).toBe("media.example.org");
      expect(c.headers["x-forwarded-proto"]).toBe("https");
    }
  });

  it("records a volunteer without a member number as 'volunteer'", async () => {
    h = await startHarness();
    h.auth.respond = signedInAs({ claims: ["volunteer"], memberId: null, email: "vol@sdfwa.org", name: "Val Volunteer" });

    await finish(await upload(jpeg()));

    expect(only(h.fakeRs.resources).fields).toMatchObject({
      submittername: "Val Volunteer",
      submitteremail: "vol@sdfwa.org",
      submittermemberid: "volunteer",
    });
  });

  it("writes an audit line for the upload and for the hand-off, with who, the size and the type", async () => {
    h = await startHarness();
    h.auth.respond = member();

    const id = await upload(jpeg(300_000));
    await finish(id);

    const lines = h.auditLines.map((l) => JSON.parse(l));
    expect(lines.find((l) => l.outcome === "sent")).toMatchObject({
      event: "upload_request",
      uploadId: id,
      sizeBytes: 300_000,
      detectedType: "image/jpeg",
      submissionId: expect.stringMatching(/^[a-z0-9]{12}$/),
      user: { id: "u-42", email: "pat@example.org", memberId: "M-1234" },
    });
    expect(lines.find((l) => l.outcome === "created")).toMatchObject({
      method: "POST",
      path: expect.stringMatching(/^\/upload\/api\/files\/?$/),
      uploadId: id,
    });
  });
});

describe("Submitter fields", () => {
  it("come only from the verified session; anything the browser sends for them is ignored", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const forged = {
      submittername: "Mallory",
      submitteremail: "mallory@evil.example",
      submittermemberid: "M-0001",
      submissionid: "forged",
      submitterrights: "nope",
      owner: "u-1",
    };

    const id = await upload(jpeg(), { metadata: { filename: "IMG_1.JPG", ...forged } });
    const res = await finish(id, {
      ...forged,
      submitterName: "Mallory",
      submitterEmail: "mallory@evil.example",
      memberId: "M-0001",
      email: "mallory@evil.example",
      name: "Mallory",
      fields: { submittername: "Mallory" },
    });

    expect(res.status).toBe(200);
    const fields = only(h.fakeRs.resources).fields;
    expect(fields).toMatchObject({
      submittername: "Pat Member",
      submitteremail: "pat@example.org",
      submittermemberid: "M-1234",
    });
    expect(fields.submissionid).not.toBe("forged");
    expect(fields.submitterrights).toMatch(/^Confirmed /);
    expect(JSON.stringify(fields)).not.toMatch(/Mallory|mallory|M-0001/);
    // Only the Title and the six Submitter fields are written: nothing else the browser sent.
    expect(Object.keys(fields).sort()).toEqual(
      ["submissionid", "submitteremail", "submitterfilename", "submittermemberid", "submittername", "submitterrights", "title"],
    );
  });

  it("cannot be borrowed: only the member who sent the photo can hand it over", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const id = await upload(jpeg());

    h.auth.respond = signedInAs({ claims: ["member"], id: "u-99", email: "other@example.org" });
    const res = await finish(id);

    expect(res.status).toBe(404);
    expect(h.fakeRs.resources.size).toBe(0);
  });
});

describe("the staged file", () => {
  it("is deleted once ResourceSpace confirms the Item", async () => {
    h = await startHarness();
    h.auth.respond = member();

    const id = await upload(jpeg());
    expect((await readdir(h.stagingDir)).some((f) => f.startsWith(id))).toBe(true);
    await finish(id);

    // Only the small record of which ResourceSpace Item it became remains.
    expect((await readdir(h.stagingDir)).filter((f) => f.startsWith(id))).toEqual([`${id}.item.json`]);
  });

  it("is kept while ResourceSpace has not confirmed, so the member can try again", async () => {
    h = await startHarness();
    h.auth.respond = member();
    h.fakeRs.failWhen = (c) => (c.fn === "upload_multipart" ? { status: 500, json: { status: "FAILED" } } : undefined);

    const id = await upload(jpeg());
    const res = await finish(id);

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "not_saved" });
    expect(await readdir(h.stagingDir)).toContain(id);
  });

  it("is stored under a server-made id, never the name the browser gave", async () => {
    h = await startHarness();
    h.auth.respond = member();

    const id = await upload(jpeg(), { metadata: { filename: "../../etc/passwd" } });

    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect((await readdir(h.stagingDir)).every((f) => f.startsWith(id))).toBe(true);
  });
});

describe("trying again", () => {
  it("reuses the same ResourceSpace Item when the hand-off failed partway", async () => {
    h = await startHarness();
    h.auth.respond = member();
    let failures = 1;
    h.fakeRs.failWhen = (c) =>
      c.fn === "update_field" && c.params.get("field") === "submitteremail" && failures-- > 0
        ? { status: 500, body: "boom" }
        : undefined;

    const id = await upload(jpeg());
    expect((await finish(id)).status).toBe(502);
    expect((await finish(id)).status).toBe(200);

    const item = only(h.fakeRs.resources);
    expect(item.fields.submitteremail).toBe("pat@example.org");
    expect(h.fakeRs.calls.filter((c) => c.fn === "create_resource")).toHaveLength(1);
    expect(h.fakeRs.calls.filter((c) => c.fn === "upload_multipart")).toHaveLength(1);
  });

  it("reuses the Item when the file upload to ResourceSpace failed", async () => {
    h = await startHarness();
    h.auth.respond = member();
    let failures = 1;
    h.fakeRs.failWhen = (c) => (c.fn === "upload_multipart" && failures-- > 0 ? { status: 500, body: "" } : undefined);

    const id = await upload(jpeg());
    expect((await finish(id)).status).toBe(502);
    expect((await finish(id)).status).toBe(200);

    expect(only(h.fakeRs.resources).file).toBeDefined();
    expect(h.fakeRs.calls.filter((c) => c.fn === "create_resource")).toHaveLength(1);
  });

  it("answers sent again, without a second Item, when the first answer was lost", async () => {
    h = await startHarness();
    h.auth.respond = member();

    const id = await upload(jpeg());
    expect((await finish(id)).status).toBe(200);
    const again = await finish(id);

    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: "sent" });
    expect(h.fakeRs.resources.size).toBe(1);
  });

  it("never makes two Items when the same photo is handed over twice at once", async () => {
    h = await startHarness();
    h.auth.respond = member();

    const id = await upload(jpeg());
    const [a, b] = await Promise.all([finish(id), finish(id)]);

    expect([a.status, b.status]).toEqual([200, 200]);
    expect(h.fakeRs.resources.size).toBe(1);
  });

  it("does not let someone else replay a sent upload", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const id = await upload(jpeg());
    await finish(id);

    h.auth.respond = signedInAs({ claims: ["member"], id: "u-99" });

    expect((await finish(id)).status).toBe(404);
  });
});

describe("what the service refuses", () => {
  it("a file that is not a photo, whatever it is called, and removes it from staging", async () => {
    h = await startHarness();
    h.auth.respond = member();

    const id = await upload(Buffer.from("#!/bin/sh\necho not a photo\n".repeat(100)), {
      metadata: { filename: "IMG_0001.JPG", filetype: "image/jpeg" },
    });
    const res = await finish(id);

    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: "not_a_photo" });
    expect(h.fakeRs.calls).toHaveLength(0);
    expect((await readdir(h.stagingDir)).filter((f) => f.startsWith(id) && !f.endsWith(".item.json"))).toEqual([]);
  });

  it("a hand-off with no Title", async () => {
    h = await startHarness();
    h.auth.respond = member();

    const res = await finish(await upload(jpeg()), { title: "   " });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "title_required" });
    expect(h.fakeRs.calls).toHaveLength(0);
  });

  it("a hand-off without the rights confirmation", async () => {
    h = await startHarness();
    h.auth.respond = member();

    const res = await finish(await upload(jpeg()), { rightsConfirmed: "yes" });

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "rights_required" });
  });

  it("a hand-off before the whole photo has arrived", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const create = await fetch(`${h.url}/upload/api/files/`, {
      method: "POST",
      headers: { cookie: COOKIE, "tus-resumable": "1.0.0", "upload-length": "1000" },
    });
    expect(create.status).toBe(201);
    const id = create.headers.get("location")!.split("/").pop()!;

    const res = await finish(id);

    expect(res.status).toBe(409);
    expect(h.fakeRs.calls).toHaveLength(0);
  });

  it("an unknown upload id", async () => {
    h = await startHarness();
    h.auth.respond = member();

    expect((await finish("0".repeat(32))).status).toBe(404);
    expect((await finish("../../etc/passwd")).status).toBe(404);
  });

  it("a photo over the size limit, before storing it", async () => {
    h = await startHarness({ PHOTO_MAX_BYTES: "100000" });
    h.auth.respond = member();

    await expect(upload(jpeg(100_001))).rejects.toThrow(/413/);
    expect(await readdir(h.stagingDir)).toEqual([]);
  });

  it("a hand-off that is not JSON", async () => {
    h = await startHarness();
    h.auth.respond = member();

    const res = await fetch(`${h.url}/upload/api/items`, {
      method: "POST",
      headers: { cookie: COOKIE, "content-type": "text/plain" },
      body: "uploadId=x",
    });

    expect(res.status).toBe(415);
  });

  it("downloading a staged file, even your own", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const create = await fetch(`${h.url}/upload/api/files/`, {
      method: "POST",
      headers: { cookie: COOKIE, "tus-resumable": "1.0.0", "upload-length": "10" },
    });

    const res = await fetch(new URL(create.headers.get("location")!, h.url), { headers: { cookie: COOKIE } });

    expect(res.status).toBe(405);
  });

  it("someone else's upload: they cannot see or add to it", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const create = await fetch(`${h.url}/upload/api/files/`, {
      method: "POST",
      headers: { cookie: COOKIE, "tus-resumable": "1.0.0", "upload-length": "10" },
    });
    const location = create.headers.get("location")!;

    h.auth.respond = signedInAs({ claims: ["member"], id: "u-99" });
    const head = await fetch(new URL(location, h.url), { method: "HEAD", headers: { cookie: COOKIE, "tus-resumable": "1.0.0" } });
    const patch = await fetch(new URL(location, h.url), {
      method: "PATCH",
      headers: {
        cookie: COOKIE,
        "tus-resumable": "1.0.0",
        "upload-offset": "0",
        "content-type": "application/offset+octet-stream",
      },
      body: Buffer.alloc(10),
    });

    expect(head.status).toBe(404);
    expect(patch.status).toBe(404);
  });
});

describe("without the ResourceSpace key configured", () => {
  it("fails closed: no uploads are taken and the page shows the temporary problem", async () => {
    h = await startHarness({ RS_UPLOADER_API_KEY: "" });
    h.auth.respond = member();

    await expect(upload(jpeg())).rejects.toThrow(/503/);
    const page = await fetch(`${h.url}/upload/`, { headers: { cookie: COOKIE } });
    const health = await fetch(`${h.url}/upload/health`);

    expect(page.status).toBe(503);
    expect(await page.text()).toContain('"screen":"unavailable"');
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ resourcespace: { configured: false } });
    expect(await readdir(h.stagingDir)).toEqual([]);
  });

  it("still sends visitors to sign in and non-members to the renewal page", async () => {
    h = await startHarness({ RS_UPLOADER_API_KEY: "" });

    h.auth.respond = () => ({ json: { user: null } });
    expect((await fetch(`${h.url}/upload/`, { headers: { cookie: COOKIE }, redirect: "manual" })).status).toBe(302);
    h.auth.respond = signedInAs({ claims: [] });
    expect((await fetch(`${h.url}/upload/`, { headers: { cookie: COOKIE } })).status).toBe(403);
  });
});

describe("the ResourceSpace key", () => {
  it("never reaches the browser or the audit log", async () => {
    h = await startHarness();
    h.auth.respond = member();

    const page = await (await fetch(`${h.url}/upload/`, { headers: { cookie: COOKIE } })).text();
    const session = await (await fetch(`${h.url}/upload/api/session`, { headers: { cookie: COOKIE } })).text();
    const id = await upload(jpeg());
    const sent = await (await finish(id)).text();
    h.fakeRs.failWhen = () => ({ status: 500, body: FAKE_RS_KEY });
    const failed = await (await finish(await upload(jpeg()))).text();
    const health = await (await fetch(`${h.url}/upload/health`)).text();

    for (const text of [page, session, sent, failed, health, h.auditLines.join("\n")]) {
      expect(text).not.toContain(FAKE_RS_KEY);
    }
  });
});
