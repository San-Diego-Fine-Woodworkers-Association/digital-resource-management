// Seam 1: telling the Reviewers (#61). One email per Submission, through a
// fake of the Google Workspace SMTP relay (STARTTLS, no auth): complete when
// every Item is in, partial when the page says it finished with some not
// sent or when nothing arrives for the stall time, the generic notice when
// the Submission's record is gone, and never anything the member sees.
// The service's clock is moved on instead of waiting; `check()` is what the
// stall timer calls.
import { readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { client, jpeg, member, mp4, startBody } from "./testing/client.ts";
import { startFakeSmtp, type FakeSmtp, type Received } from "./testing/fake-smtp.ts";
import { COOKIE, PUBLIC_BASE_URL, startHarness, type Harness, type HarnessOptions } from "./testing/harness.ts";

let h: Harness | undefined;
let smtp: FakeSmtp | undefined;
afterEach(async () => {
  await h?.notifier().idle();
  await h?.close();
  await smtp?.close();
  h = smtp = undefined;
});

const MINUTE = 60_000;

/** The service with the Reviewers' email on, sending to a fake relay; a member signed in. */
async function start(env: Record<string, string> = {}, opts: HarnessOptions = {}) {
  smtp = await startFakeSmtp();
  h = await startHarness(
    { REVIEWER_EMAIL_PAUSED: "false", SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtp.port), ...env },
    opts,
  );
  h.auth.respond = member();
  return { h, smtp, c: client(h) };
}

/** Sends one file into the Submission and hands it over. */
async function sendOne(submission: string, file = jpeg()) {
  const c = client(h!);
  const res = await c.finish(await c.upload(file, { submission }));
  expect(res.status).toBe(200);
}

function finished(submission: string, cookie = COOKIE) {
  return fetch(`${h!.url}/upload/api/submissions/${submission}/finished`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: "{}",
  });
}

/** Moves the clock past the stall time and lets the timer's check run. */
async function stall(minutes = 31) {
  h!.advance(minutes * MINUTE);
  h!.notifier().check();
  await h!.notifier().idle();
}

const settle = () => h!.notifier().idle();
const only = (): Received => {
  expect(smtp!.received).toHaveLength(1);
  return smtp!.received[0]!;
};
const reviewLink = (id: string) => `${PUBLIC_BASE_URL}/pages/search.php?search=submissionid%3A${id}&archive=-1`;
const emailLines = (h: Harness) => h.auditLines.map((l) => JSON.parse(l)).filter((l) => l.event === "reviewer_email");

describe("when every Item is in", () => {
  it("sends one complete email at once, through the relay as set up", async () => {
    const { c } = await start();
    const s = await c.startSubmission(COOKIE, startBody({
      expectedItems: 3,
      details: { location: "Shop", eventname: "", caption: "Hand-cut dovetails.\nSecond line." },
    }));
    await sendOne(s);
    await sendOne(s);
    await settle();
    expect(smtp!.received).toHaveLength(0);
    await sendOne(s, mp4());
    await settle();

    const m = only();
    expect(m.secure).toBe(true);
    expect(m.ehlo).toBe("media.sdfwa.org");
    expect(m.from).toBe("no-reply@sdfwa.org");
    expect(m.mail.from?.value).toEqual([{ name: "SDFWA Media", address: "no-reply@sdfwa.org" }]);
    expect(m.to).toEqual(["media-reviewers@sdfwa.org"]);
    expect(m.mail.subject).toBe("New photos from Pat Member: Dovetail class, May 3 (2 photos, 1 video)");
    expect(m.mail.replyTo?.value).toEqual([{ name: "Pat Member", address: "pat@example.org" }]);
    expect(m.mail.headers.get("auto-submitted")).toBe("auto-generated");

    const text = m.mail.text!;
    expect(text).toContain("Pat Member sent 2 photos, 1 video.");
    expect(text).toContain("From: Pat Member (pat@example.org)");
    expect(text).toContain("Title: Dovetail class, May 3");
    expect(text).toContain("Program / Event: Classes & Workshops");
    expect(text).toContain("Subject Type(s): Instruction / Class in Session");
    expect(text).toContain("Location: Shop");
    expect(text).toContain("Caption: Hand-cut dovetails.\nSecond line.");
    // Empty optional answers are left out.
    expect(text).not.toContain("Date:");
    expect(text).not.toContain("Event name:");
    expect(text).toContain(reviewLink(s));
    expect(text).not.toContain("own details");

    const html = m.mail.html as string;
    expect(html).toContain(`href="${reviewLink(s).replace(/&/g, "&amp;")}"`);
    expect(html).toContain("Classes &amp; Workshops");
    expect(html).not.toContain("<img");
    expect(emailLines(h!)).toEqual([expect.objectContaining({ outcome: "sent_complete", submissionId: s })]);
  });

  it("says how many have their own details, without listing them", async () => {
    const { c } = await start();
    const s = await c.startSubmission(COOKIE, {
      ...startBody({ expectedItems: 3 }),
      items: { "1": { title: "My jack plane" }, "3": { location: "Shop" } },
    });
    for (const item of ["1", "2", "3"]) {
      expect((await c.finish(await c.upload(jpeg(), { submission: s }), { item })).status).toBe(200);
    }
    await settle();
    const text = only().mail.text!;
    expect(text).toContain("2 have their own details.");
    expect(text).not.toContain("My jack plane");
  });

  it("is not followed by another when the page then says it finished", async () => {
    const { c } = await start();
    const s = await c.startSubmission(COOKIE, startBody({ expectedItems: 1 }));
    await sendOne(s);
    expect((await finished(s)).status).toBe(202);
    await stall();
    expect(only().mail.subject).toMatch(/^New photos from/);
  });
});

describe("when the page finishes with some not sent", () => {
  it("sends one partial email at once, and nothing more for Items that arrive later", async () => {
    const { c } = await start();
    const s = await c.startSubmission(COOKIE, startBody({ expectedItems: 4 }));
    await sendOne(s);
    await sendOne(s, mp4());
    await settle();
    expect(smtp!.received).toHaveLength(0);

    const res = await finished(s);
    expect(res.status).toBe(202);
    await settle();

    const m = only();
    expect(m.mail.subject).toBe("Partly sent: New photos from Pat Member: Dovetail class, May 3 (2 of 4 sent)");
    expect(m.mail.text).toContain("Not everything Pat Member sent has arrived: 2 of 4 sent (1 photo, 1 video).");
    expect(m.mail.text).toContain("Sent: 2 of 4 (1 photo, 1 video)");
    expect(m.mail.text).toContain("The member's page finished with some not sent.");
    expect(m.mail.text).toContain(reviewLink(s));

    // The member presses Try again; the rest arrive.
    await sendOne(s);
    await sendOne(s);
    expect((await finished(s)).status).toBe(202);
    await stall();
    expect(smtp!.received).toHaveLength(1);
  });

  it("is only the starting member's to say, and is audited", async () => {
    const { c } = await start();
    const s = await c.startSubmission(COOKIE, startBody({ expectedItems: 2 }));
    await sendOne(s);
    h!.auth.respond = member({ id: "u-other", email: "other@example.org" });
    expect((await finished(s)).status).toBe(404);
    expect((await finished("zzzzzzzzzzzz")).status).toBe(404);
    expect((await finished("NOT-AN-ID")).status).toBe(404);
    await settle();
    expect(smtp!.received).toHaveLength(0);

    h!.auth.respond = member();
    const notJson = await fetch(`${h!.url}/upload/api/submissions/${s}/finished`, { method: "POST", headers: { cookie: COOKIE } });
    expect(notJson.status).toBe(415);
    expect((await finished(s)).status).toBe(202);
    await settle();
    expect(only().mail.subject).toMatch(/^Partly sent: /);
    const audited = h!.auditLines.map((l) => JSON.parse(l)).filter((l) => l.path?.endsWith("/finished"));
    expect(audited.map((l) => l.outcome)).toEqual(["not_found", "not_found", "not_found", "invalid", "finished"]);
    expect(audited.at(-1)).toMatchObject({ submissionId: s, user: { id: "u-42" } });
  });

  it("goes through the member's rate limit like any other call", async () => {
    const { c } = await start({ RATE_USER_BURST: "2", RATE_USER_PER_MINUTE: "1" });
    const s = await c.startSubmission(COOKIE, startBody({ expectedItems: 2 }));
    expect((await finished(s)).status).toBe(202);
    expect((await finished(s)).status).toBe(429);
  });

  it("waits for the stall when none arrived, and then sends nothing: there is nothing to review", async () => {
    const { c } = await start();
    const s = await c.startSubmission(COOKIE, startBody({ expectedItems: 2 }));
    expect((await finished(s)).status).toBe(202);
    await stall();
    expect(smtp!.received).toHaveLength(0);
    expect(h!.notifier().pending(s)).toBe(false);
    expect(h!.logLines.map((l) => l.message)).toContain("no reviewer email: nothing in the Submission arrived");
  });
});

describe("when nothing arrives for the stall time", () => {
  it("sends one partial email, saying so", async () => {
    const { c } = await start();
    const s = await c.startSubmission(COOKIE, startBody({ expectedItems: 3 }));
    await sendOne(s);
    await stall(29);
    expect(smtp!.received).toHaveLength(0);
    await stall(2);

    const m = only();
    expect(m.mail.subject).toBe("Partly sent: New photos from Pat Member: Dovetail class, May 3 (1 of 3 sent)");
    expect(m.mail.text).toContain("Nothing more has arrived for 30 minutes.");
    await stall(60);
    expect(smtp!.received).toHaveLength(1);
  });

  it("waits longer while chunks of a slow upload keep arriving", async () => {
    const { c } = await start({ REVIEWER_EMAIL_STALL_MINUTES: "10" });
    const s = await c.startSubmission(COOKIE, startBody({ expectedItems: 2 }));
    await sendOne(s);
    // A big video, a chunk every 8 minutes: well past the stall time in all, never that long between chunks.
    const video = mp4(400_000);
    const created = await c.create(s, video.length);
    const id = created.headers.get("location")!.split("/").pop()!;
    for (let offset = 0; offset < video.length; offset += 100_000) {
      await stall(8);
      const res = await fetch(`${h!.url}/upload/api/files/${id}`, {
        method: "PATCH",
        headers: { cookie: COOKIE, "tus-resumable": "1.0.0", "upload-offset": String(offset), "content-type": "application/offset+octet-stream" },
        body: new Uint8Array(video.subarray(offset, offset + 100_000)),
      });
      expect(res.status).toBe(204);
    }
    expect(smtp!.received.map((r) => r.mail.subject)).toEqual([]);
    expect((await c.finish(id)).status).toBe(200);
    await settle();
    expect(only().mail.subject).toBe("New photos from Pat Member: Dovetail class, May 3 (1 photo, 1 video)");
  });
});

describe("after a restart", () => {
  it("still sends the pending email, with everything that had arrived", async () => {
    const { c } = await start();
    const s = await c.startSubmission(COOKIE, startBody({ expectedItems: 3 }));
    await sendOne(s);
    await sendOne(s);
    await settle();
    await h!.restart();

    // A fresh stall time from the restart: the page could not get through meanwhile.
    await stall(20);
    expect(smtp!.received).toHaveLength(0);
    await stall(11);
    expect(only().mail.subject).toBe("Partly sent: New photos from Pat Member: Dovetail class, May 3 (2 of 3 sent)");
  });

  it("sends at once what was due when it stopped: the page had said it finished", async () => {
    const { c } = await start({}, { emailRetryDelaysMs: [60_000, 60_000, 60_000] });
    const s = await c.startSubmission(COOKIE, startBody({ expectedItems: 3 }));
    await sendOne(s);
    smtp!.refuseNext = 100;
    expect((await finished(s)).status).toBe(202);
    while (smtp!.tries === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    // Stopped mid-retry: the relay never took it.
    await h!.restart();
    smtp!.refuseNext = 0;
    await settle();
    expect(only().mail.subject).toMatch(/^Partly sent: .*\(1 of 3 sent\)$/);
  });

  it("counts an Item whose arrival was not yet written down", async () => {
    const { c } = await start();
    const s = await c.startSubmission(COOKIE, startBody({ expectedItems: 2 }));
    await sendOne(s);
    await sendOne(s);
    await settle();
    smtp!.received.length = 0;
    // As if it stopped between the Item reaching ResourceSpace and the email's state being written.
    const state = path.join(h!.stagingDir, `${s}.notify.json`);
    const { readFile } = await import("node:fs/promises");
    const saved = JSON.parse(await readFile(state, "utf8"));
    await writeFile(state, JSON.stringify({ ...saved, status: "pending", sent: {}, outcome: undefined }));
    await h!.restart();
    await settle();
    expect(only().mail.subject).toBe("New photos from Pat Member: Dovetail class, May 3 (2 photos)");
  });

  it("does not send again what had gone", async () => {
    const { c } = await start();
    const s = await c.startSubmission(COOKIE, startBody({ expectedItems: 1 }));
    await sendOne(s);
    await settle();
    await h!.restart();
    await stall();
    expect(smtp!.received).toHaveLength(1);
  });
});

describe("when the Submission's record is gone", () => {
  it("sends the generic notice, with who sent it and the link", async () => {
    const { c } = await start();
    const s = await c.startSubmission(COOKIE, startBody({ expectedItems: 3 }));
    await sendOne(s);
    await settle();
    // Staging damaged, or edited by hand, while the email waited.
    await rm(path.join(h!.stagingDir, `${s}.submission.json`));
    await h!.restart();
    await stall();

    const m = only();
    expect(m.mail.subject).toBe("An incomplete Submission may be ready for review");
    expect(m.mail.text).toContain("From: Pat Member (pat@example.org)");
    expect(m.mail.text).toContain("Arrived so far: 1 photo");
    expect(m.mail.text).toContain(`Submission ID: ${s}`);
    expect(m.mail.text).toContain(reviewLink(s));
    expect(m.mail.text).not.toContain("Dovetail");
    expect(m.mail.replyTo?.value[0]?.address).toBe("pat@example.org");
  });

  it("or unreadable, and so is its email's own state", async () => {
    const { c } = await start();
    const s = await c.startSubmission(COOKIE, startBody({ expectedItems: 3 }));
    await sendOne(s);
    await settle();
    await writeFile(path.join(h!.stagingDir, `${s}.submission.json`), "{not json");
    await writeFile(path.join(h!.stagingDir, `${s}.notify.json`), "");
    await h!.restart();
    // Neither can say whose it is now.
    expect((await finished(s)).status).toBe(404);
    await stall();

    const m = only();
    expect(m.mail.subject).toBe("An incomplete Submission may be ready for review");
    expect(m.mail.text).toContain(reviewLink(s));
    expect(m.mail.replyTo).toBeUndefined();
  });
});

describe("a send that fails", () => {
  it("is tried 3 more times, then logged, and the member never knows", async () => {
    const { c } = await start();
    smtp!.refuseNext = 100;
    const s = await c.startSubmission(COOKIE, startBody({ expectedItems: 1 }));
    const c2 = client(h!);
    const res = await c2.finish(await c2.upload(jpeg(), { submission: s }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "sent" });
    await settle();

    expect(smtp!.tries).toBe(4);
    expect(smtp!.received).toHaveLength(0);
    expect(h!.logLines.filter((l) => l.message === "could not send the reviewer email")).toHaveLength(4);
    expect(emailLines(h!)).toEqual([expect.objectContaining({ outcome: "failed", submissionId: s })]);
    expect(h!.notifier().pending(s)).toBe(false);
    // Given up for good: not tried again later, or after a restart.
    smtp!.refuseNext = 0;
    await stall();
    await h!.restart();
    await stall();
    expect(smtp!.tries).toBe(4);
  });

  it("goes once the relay takes it again", async () => {
    const { c } = await start();
    smtp!.refuseNext = 2;
    const s = await c.startSubmission(COOKIE, startBody({ expectedItems: 1 }));
    await sendOne(s);
    await settle();
    expect(smtp!.tries).toBe(3);
    expect(only().mail.subject).toMatch(/^New photos/);
  });
});

describe("what members type", () => {
  it("is escaped in the HTML and cannot add a header", async () => {
    const { c } = await start();
    h!.auth.respond = member({ name: "Pat\r\nBcc: victim@example.org" });
    const s = await c.startSubmission(COOKIE, startBody({
      expectedItems: 1,
      details: { title: "<script>alert(1)</script>", caption: `"><img src=x onerror=alert(1)> & co` },
    }));
    await sendOne(s);
    await settle();

    const m = only();
    expect(m.to).toEqual(["media-reviewers@sdfwa.org"]);
    expect(m.mail.bcc).toBeUndefined();
    expect(m.raw.split("\r\n\r\n")[0]).not.toMatch(/^Bcc:/im);
    expect(m.mail.subject).toBe("New photos from Pat Bcc: victim@example.org: <script>alert(1)</script> (1 photo)");
    const html = m.mail.html as string;
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt; &amp; co");
  });
});

describe("staging", () => {
  it("keeps a Submission's record while its email is still to go", async () => {
    const { c } = await start();
    const s = await c.startSubmission(COOKIE, startBody({ expectedItems: 2 }));
    await sendOne(s);
    await settle();
    const { utimes } = await import("node:fs/promises");
    const old = new Date(Date.now() - 25 * 60 * MINUTE);
    for (const n of [`${s}.submission.json`, `${s}.notify.json`]) await utimes(path.join(h!.stagingDir, n), old, old);
    h!.advance(25 * 60 * MINUTE);

    await h!.sweep();
    expect((await readdir(h!.stagingDir)).filter((n) => n.startsWith(s)).sort()).toEqual([`${s}.notify.json`, `${s}.submission.json`]);

    h!.notifier().check();
    await settle();
    expect(only().mail.subject).toMatch(/1 of 2 sent/);
    // Gone: both are swept once a day old.
    for (const n of [`${s}.submission.json`, `${s}.notify.json`]) await utimes(path.join(h!.stagingDir, n), old, old);
    await h!.sweep();
    expect((await readdir(h!.stagingDir)).filter((n) => n.startsWith(s))).toEqual([]);
  });
});

describe("the kill switch", () => {
  it("REVIEWER_EMAIL_PAUSED schedules and sends nothing, and the member sees no difference", async () => {
    const { c } = await start({ REVIEWER_EMAIL_PAUSED: "true" });
    const s = await c.startSubmission(COOKIE, startBody({ expectedItems: 1 }));
    await sendOne(s);
    expect((await finished(s)).status).toBe(202);
    await stall();
    expect(smtp!.tries).toBe(0);
    expect((await readdir(h!.stagingDir)).some((n) => n.endsWith(".notify.json"))).toBe(false);
  });
});
