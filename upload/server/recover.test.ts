// Seam 1: when things go wrong (#58). Whatever fails and however often the
// page tries again, a photo becomes exactly one Item; the service tries
// ResourceSpace again itself before it says Couldn't save; and the Items of a
// Submission that did make it are complete without the ones that did not.
// ResourceSpace is the fake (testing/fake-rs.ts), failing on demand.
import { readdir } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { client, jpeg, member, mp4, startBody } from "./testing/client.ts";
import { COOKIE, startHarness, type Harness, type SeenRequest } from "./testing/harness.ts";

let h: Harness;
afterEach(async () => h?.close());

const status = async (id: string) =>
  (await fetch(`${h.url}/upload/api/items/${id}`, { headers: { cookie: COOKIE } })).json() as Promise<{ status: string }>;

const calls = (fn: string) => h.fakeRs.calls.filter((c) => c.fn === fn);

/** Waits until `check` holds, as a test cannot know exactly when the service gets there. */
async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("never happened");
}

/** Makes ResourceSpace slow to answer the file upload, as it is while it makes a video's previews. */
function slowUpload(ms: number) {
  const normal = h.rs.respond;
  h.rs.respond = (req: SeenRequest) => {
    const reply = normal(req);
    return req.url.includes("function=upload_multipart") ? { ...reply, delayMs: ms } : reply;
  };
}

/** The fields every Item needs before a Reviewer can approve it. */
const REQUIRED = ["title", "programevent", "subjecttype", "submittername", "submitteremail", "submissionid", "submitterrights"];

describe("a dropped connection after ResourceSpace has the Item", () => {
  it("and trying again gives exactly one Item", async () => {
    h = await startHarness();
    h.auth.respond = member();
    slowUpload(300);
    const id = await client(h).upload(jpeg());

    // The member's connection drops once ResourceSpace has made the Item.
    const dropped = new AbortController();
    const first = fetch(`${h.url}/upload/api/items`, {
      method: "POST",
      headers: { cookie: COOKIE, "content-type": "application/json" },
      body: JSON.stringify({ uploadId: id }),
      signal: dropped.signal,
    }).catch(() => "dropped");
    await until(() => calls("create_resource").length === 1);
    dropped.abort();
    expect(await first).toBe("dropped");

    // The page tries again while the first hand-off is still going.
    const again = await client(h).finish(id);

    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: "sent" });
    expect(h.fakeRs.resources.size).toBe(1);
    expect(calls("create_resource")).toHaveLength(1);
    expect(calls("upload_multipart")).toHaveLength(1);
  });

  it("and trying again after the hand-off has ended answers from the record", async () => {
    h = await startHarness();
    h.auth.respond = member();
    slowUpload(100);
    const id = await client(h).upload(jpeg());

    const dropped = new AbortController();
    const first = fetch(`${h.url}/upload/api/items`, {
      method: "POST",
      headers: { cookie: COOKIE, "content-type": "application/json" },
      body: JSON.stringify({ uploadId: id }),
      signal: dropped.signal,
    }).catch(() => "dropped");
    await until(() => calls("create_resource").length === 1);
    dropped.abort();
    await first;
    // The hand-off carries on without the page.
    await until(async () => (await status(id)).status === "sent");

    expect((await client(h).finish(id)).status).toBe(200);
    expect(h.fakeRs.resources.size).toBe(1);
    expect(calls("create_resource")).toHaveLength(1);
  });

  it("and trying again after the service restarted reuses the Item it recorded", async () => {
    h = await startHarness();
    h.auth.respond = member();
    let failures = 1;
    h.fakeRs.failWhen = (c) => (c.fn === "upload_multipart" && failures-- > 0 ? { status: 500, body: "boom" } : undefined);
    const id = await client(h).upload(jpeg());
    expect((await client(h).finish(id)).status).toBe(502);

    await h.restart();
    expect(await status(id)).toEqual({ status: "not_saved" });
    expect((await client(h).finish(id)).status).toBe(200);

    expect(h.fakeRs.resources.size).toBe(1);
    expect(calls("create_resource")).toHaveLength(1);
    expect([...h.fakeRs.resources.values()][0]!.file).toBeDefined();
  });
});

describe("ResourceSpace's answer to making the Item is lost", () => {
  it("is noted before asking, so the next try logs the empty Item it may have left; the photo is still in one Item", async () => {
    h = await startHarness({ RS_API_TIMEOUT_MS: "100" });
    h.auth.respond = member();
    let lose = true;
    h.fakeRs.failWhen = (c) => {
      if (c.fn !== "create_resource" || !lose) return undefined;
      lose = false;
      // ResourceSpace makes it, but its answer never arrives.
      h.fakeRs.resources.set(1, { ref: 1, resourceType: 1, archive: -1, fields: {} });
      return { hang: true };
    };
    const id = await client(h).upload(jpeg());

    expect((await client(h).finish(id)).status).toBe(502);
    expect(await status(id)).toEqual({ status: "not_saved" });
    expect(h.logLines.some((l) => /may hold an empty Item/.test(l.message))).toBe(false);

    expect((await client(h).finish(id)).status).toBe(200);

    const empty = h.logLines.find((l) => /may hold an empty Item/.test(l.message));
    expect(empty?.fields).toMatchObject({ uploadId: id, askedAt: expect.any(String) });
    // The photo and its answers went only to the Item whose number came back.
    const withFile = [...h.fakeRs.resources.values()].filter((r) => r.file);
    expect(withFile).toHaveLength(1);
    expect(h.fakeRs.resources.get(1)).toMatchObject({ fields: {} });
    expect(h.fakeRs.resources.get(1)!.file).toBeUndefined();
  });

  it("is not suspected when ResourceSpace answered that it made nothing", async () => {
    h = await startHarness();
    h.auth.respond = member();
    let failures = 1;
    h.fakeRs.failWhen = (c) => (c.fn === "create_resource" && failures-- > 0 ? { status: 500, body: "boom" } : undefined);
    const id = await client(h).upload(jpeg());

    expect((await client(h).finish(id)).status).toBe(502);
    expect((await client(h).finish(id)).status).toBe(200);

    expect(h.logLines.some((l) => /empty Item/.test(l.message))).toBe(false);
    expect(h.fakeRs.resources.size).toBe(1);
  });

  it("is logged by the sweep when the member never tries again", async () => {
    h = await startHarness({ RS_API_TIMEOUT_MS: "100" });
    h.auth.respond = member();
    h.fakeRs.failWhen = (c) => (c.fn === "create_resource" ? { hang: true } : undefined);
    const id = await client(h).upload(jpeg());
    expect((await client(h).finish(id)).status).toBe(502);

    h.advance(25 * 60 * 60 * 1000);
    await h.sweep();

    const line = h.logLines.find((l) => /gave up on an Item whose create got no answer/.test(l.message));
    expect(line?.fields).toMatchObject({ uploadId: id });
    expect(await readdir(h.stagingDir)).not.toContain(`${id}.item.json`);
  });
});

describe("the service's own retries before Couldn't save (#30)", () => {
  it("try ResourceSpace again when it answers with a failure, keeping the one Item", async () => {
    h = await startHarness({}, { rsRetryDelaysMs: [1, 1] });
    h.auth.respond = member();
    let failures = 2;
    h.fakeRs.failWhen = (c) =>
      c.fn === "update_field" && c.params.get("field") === "title" && failures-- > 0 ? { status: 500, body: "boom" } : undefined;
    const id = await client(h).upload(jpeg());

    const res = await client(h).finish(id);

    expect(res.status).toBe(200);
    expect(h.fakeRs.resources.size).toBe(1);
    expect(calls("create_resource")).toHaveLength(1);
    expect(calls("upload_multipart")).toHaveLength(1);
    expect(h.logLines.filter((l) => /trying again/.test(l.message))).toHaveLength(2);
  });

  it("answer not_saved once they run out, and the member's Try again still finishes the same Item", async () => {
    h = await startHarness({}, { rsRetryDelaysMs: [1, 1] });
    h.auth.respond = member();
    let failures = 3;
    h.fakeRs.failWhen = (c) => (c.fn === "upload_multipart" && failures-- > 0 ? { status: 500, body: "boom" } : undefined);
    const id = await client(h).upload(jpeg());

    const res = await client(h).finish(id);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "not_saved" });
    expect(calls("upload_multipart")).toHaveLength(3);

    expect((await client(h).finish(id)).status).toBe(200);
    expect(h.fakeRs.resources.size).toBe(1);
  });

  it("do not send a file again that ResourceSpace never answered for: it already waited minutes", async () => {
    h = await startHarness({ RS_UPLOAD_TIMEOUT_MS: "100" }, { rsRetryDelaysMs: [1, 1] });
    h.auth.respond = member();
    h.fakeRs.failWhen = (c) => (c.fn === "upload_multipart" ? { hang: true } : undefined);
    const id = await client(h).upload(mp4(), { metadata: { filename: "IMG_2043.MOV" } });

    expect((await client(h).finish(id)).status).toBe(502);
    expect(calls("upload_multipart")).toHaveLength(1);
  });
});

describe("a Submission where some did not make it", () => {
  it("leaves the ones that were sent complete and approvable, and the others ready to try again", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const submission = await client(h).startSubmission(COOKIE, startBody({ expectedItems: 3 }));
    const [a, b, c] = [
      await client(h).upload(jpeg(), { submission }),
      await client(h).upload(jpeg(), { submission }),
      await client(h).upload(jpeg(), { submission }),
    ];

    expect((await client(h).finish(a)).status).toBe(200);
    h.fakeRs.failWhen = (call) => (call.fn === "upload_multipart" ? { status: 500, body: "boom" } : undefined);
    expect((await client(h).finish(b)).status).toBe(502);
    h.fakeRs.failWhen = () => undefined;
    expect((await client(h).finish(c)).status).toBe(200);

    const sent = [...h.fakeRs.resources.values()].filter((r) => r.file);
    expect(sent).toHaveLength(2);
    for (const item of sent) {
      expect(item.archive).toBe(-1);
      for (const field of REQUIRED) expect(item.fields[field], field).not.toBe("");
      expect(item.fields.submissionid).toBe(submission);
    }
    expect(await status(b)).toEqual({ status: "not_saved" });
    // The one that did not make it is still on staging for Try again.
    expect(await readdir(h.stagingDir)).toContain(b);

    expect((await client(h).finish(b)).status).toBe(200);
    expect(h.fakeRs.resources.size).toBe(3);
  });
});
