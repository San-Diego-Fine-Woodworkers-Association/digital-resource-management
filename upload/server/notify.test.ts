// The Reviewers' email on its own (#61): the stall deadline on fake timers,
// the retries' pauses, and the email's wording and safety. The whole journey
// through the service and a fake relay is reviewers.test.ts.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_DETAILS } from "../shared/details.ts";
import { createAuditLog } from "./audit.ts";
import { createNotifier, createPausedNotifier, HOLD_LIMIT_MS, type Notifier } from "./notify.ts";
import { composeEmail, escapeHtml, oneLine, reviewLink, type Email } from "./reviewer-email.ts";
import type { SubmissionRecord } from "./submissions.ts";

const MINUTE = 60_000;
const BASE = "https://media.sdfwa.org";

const record = (expectedItems: number, extra: Partial<SubmissionRecord> = {}): SubmissionRecord => ({
  submissionId: "abcdefghjkmn",
  code: "abcdef",
  owner: "u-1",
  createdAt: new Date().toISOString(),
  expectedItems,
  details: { ...NO_DETAILS, title: "Bench build", programevent: "Shop / ShopOps", subjecttype: ["Work in Progress"] },
  rights: "confirmed",
  ...extra,
});
const PAT = { name: "Pat Member", email: "pat@example.org" };

describe("the kill switch holds what was still to go", () => {
  const DAY = 24 * 60 * MINUTE;
  let dir: string;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    dir = await mkdtemp(path.join(tmpdir(), "notify-test-"));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  function notifier(sent: Email[], audit: string[] = []) {
    return createNotifier({
      dir,
      stallMs: 30 * MINUTE,
      publicBaseUrl: BASE,
      mailer: async (email) => void sent.push(email),
      audit: createAuditLog((line) => audit.push(line)),
      readRecord: async () => record(2),
      log: () => {},
    });
  }

  /** One email still to go, with one of 2 in, written now; then the service stops. */
  async function pendingOne() {
    const n = notifier([]);
    await n.started(record(2), PAT);
    await n.itemSent("abcdefghjkmn", "a".repeat(32), "photo");
    await n.idle();
    n.close();
  }

  it("keeps it pending through a paused day and more, then sends it exactly once", async () => {
    await pendingOne();
    const paused = createPausedNotifier({ dir, log: () => {} });
    await paused.load();
    await vi.advanceTimersByTimeAsync(25 * 60 * MINUTE);
    expect(paused.pending("abcdefghjkmn")).toBe(true);
    expect(paused.pending("zzzzzzzzzzzz")).toBe(false);

    const sent: Email[] = [];
    const n = notifier(sent);
    await n.load();
    await vi.advanceTimersByTimeAsync(31 * MINUTE);
    await n.idle();
    await vi.advanceTimersByTimeAsync(2 * DAY);
    await n.idle();
    expect(sent.map((e) => e.subject)).toEqual(["Partly sent: New photos from Pat Member: Bench build (1 of 2 sent)"]);
    n.close();
  });

  it("gives it up after more than 7 days held, and says so in the audit trail", async () => {
    await pendingOne();
    await vi.advanceTimersByTimeAsync(HOLD_LIMIT_MS + MINUTE);
    const sent: Email[] = [];
    const audit: string[] = [];
    const n = notifier(sent, audit);
    await n.load();
    await vi.advanceTimersByTimeAsync(31 * MINUTE);
    await n.idle();
    expect(sent).toEqual([]);
    expect(n.pending("abcdefghjkmn")).toBe(false);
    expect(audit.map((l) => JSON.parse(l).outcome)).toEqual(["held_too_long"]);
    n.close();
  });
});

describe("the stall deadline", () => {
  let dir: string;
  let sent: Email[];
  let failures: number;
  let audit: string[];
  let n: Notifier;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    dir = await mkdtemp(path.join(tmpdir(), "notify-test-"));
    sent = [];
    failures = 0;
    audit = [];
    n = createNotifier({
      dir,
      stallMs: 30 * MINUTE,
      publicBaseUrl: BASE,
      mailer: async (email) => {
        if (failures > 0) {
          failures--;
          throw new Error("421 try later");
        }
        sent.push(email);
      },
      audit: createAuditLog((line) => audit.push(line)),
      readRecord: async () => undefined,
      log: () => {},
    });
  });
  afterEach(async () => {
    n.close();
    vi.useRealTimers();
    await n.idle();
    await rm(dir, { recursive: true, force: true });
  });

  it("slides forward with every chunk, so a slow but healthy upload never trips it", async () => {
    await n.started(record(2), PAT);
    await n.itemSent("abcdefghjkmn", "a".repeat(32), "photo");
    // Two hours of a big video arriving, a chunk every 20 minutes.
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(20 * MINUTE);
      n.progress("abcdefghjkmn");
    }
    expect(sent).toHaveLength(0);
    await n.itemSent("abcdefghjkmn", "b".repeat(32), "video");
    expect(sent.map((e) => e.subject)).toEqual(["New photos from Pat Member: Bench build (1 photo, 1 video)"]);
  });

  it("trips by itself after 30 minutes with nothing arriving, and sends once", async () => {
    await n.started(record(5), PAT);
    await n.itemSent("abcdefghjkmn", "a".repeat(32), "photo");
    await vi.advanceTimersByTimeAsync(29 * MINUTE);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1 * MINUTE);
    expect(sent.map((e) => e.subject)).toEqual(["Partly sent: New photos from Pat Member: Bench build (1 of 5 sent)"]);
    await vi.advanceTimersByTimeAsync(120 * MINUTE);
    await n.itemSent("abcdefghjkmn", "b".repeat(32), "photo");
    expect(sent).toHaveLength(1);
    expect(n.pending("abcdefghjkmn")).toBe(false);
  });

  it("retries a failed send 3 times, with growing pauses, then gives up and audits it", async () => {
    failures = 10;
    await n.started(record(1), PAT);
    await n.itemSent("abcdefghjkmn", "a".repeat(32), "photo");
    expect(n.pending("abcdefghjkmn")).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(failures).toBe(8);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(failures).toBe(7);
    await vi.advanceTimersByTimeAsync(10 * MINUTE - 1);
    expect(failures).toBe(7);
    await vi.advanceTimersByTimeAsync(1);
    expect(failures).toBe(6);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(0);
    expect(n.pending("abcdefghjkmn")).toBe(false);
    expect(audit.map((l) => JSON.parse(l))).toEqual([
      expect.objectContaining({ event: "reviewer_email", outcome: "failed", submissionId: "abcdefghjkmn" }),
    ]);
  });

  it("knows nothing of a Submission it did not start, and lets only its member finish it", async () => {
    expect(await n.finished("zzzzzzzzzzzz", "u-1")).toBe("not_found");
    await n.started(record(3), PAT);
    expect(await n.finished("abcdefghjkmn", "u-2")).toBe("not_found");
    await n.itemSent("abcdefghjkmn", "a".repeat(32), "photo");
    expect(await n.finished("abcdefghjkmn", "u-1")).toBe("ok");
    expect(sent.map((e) => e.subject)).toEqual(["Partly sent: New photos from Pat Member: Bench build (1 of 3 sent)"]);
  });
});

describe("the email", () => {
  const complete = (over: Partial<Parameters<typeof composeEmail>[0]> = {}) =>
    composeEmail(
      {
        kind: "complete",
        submissionId: "abcdefghjkmn",
        submitter: PAT,
        sent: { photos: 12, videos: 2 },
        expectedItems: 14,
        details: record(14).details,
        ...over,
      },
      BASE,
    );

  it("links to the Submission's Items in Pending Review", () => {
    expect(reviewLink(BASE, "abcdefghjkmn")).toBe(
      "https://media.sdfwa.org/pages/search.php?search=submissionid%3Aabcdefghjkmn&archive=-1",
    );
    const e = complete();
    expect(e.text).toContain(reviewLink(BASE, "abcdefghjkmn"));
    expect(e.html).toContain('href="https://media.sdfwa.org/pages/search.php?search=submissionid%3Aabcdefghjkmn&amp;archive=-1"');
  });

  it("counts the way the subject does", () => {
    expect(complete().subject).toBe("New photos from Pat Member: Bench build (12 photos, 2 videos)");
    expect(complete({ sent: { photos: 1, videos: 0 } }).subject).toBe("New photos from Pat Member: Bench build (1 photo)");
    expect(complete({ sent: { photos: 0, videos: 2 } }).subject).toBe("New photos from Pat Member: Bench build (2 videos)");
    const partial = complete({ kind: "partial", sent: { photos: 7, videos: 2 }, why: { finished: true } });
    expect(partial.subject).toBe("Partly sent: New photos from Pat Member: Bench build (9 of 14 sent)");
    expect(partial.text).toContain("9 of 14 sent (7 photos, 2 videos).");
    expect(partial.text).toContain("Sent: 9 of 14 (7 photos, 2 videos)");
  });

  it("is a reply away from the member", () => {
    expect(complete().replyTo).toEqual({ name: "Pat Member", address: "pat@example.org" });
    expect(complete({ submitter: { name: "Pat", email: "pat@example.org>\r\nBcc: x@y.org" } }).replyTo).toBeUndefined();
  });

  it("says how many have their own details, and leaves out empty answers", () => {
    const e = complete({ ownDetails: 3 });
    expect(e.text).toContain("3 have their own details.");
    expect(complete({ ownDetails: 1 }).text).toContain("1 has its own details.");
    expect(e.text).not.toMatch(/^(Date|Location|Event name|Caption):/m);
    const dated = complete({ details: { ...record(1).details, date: "2026-05-03", eventname: "Spring Show" } });
    expect(dated.text).toContain("Date: May 3, 2026");
    expect(dated.text).toContain("Event name: Spring Show");
  });

  it("keeps line breaks out of headers and markup out of the HTML", () => {
    expect(oneLine("a\r\nBcc: b\u2028c\u0000")).toBe("a Bcc: b c");
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    const e = complete({
      submitter: { name: "Eve\r\nBcc: x@y.org", email: "eve@example.org" },
      details: { ...record(1).details, title: "Nice\nSubject: hi <b>bold</b>" },
    });
    expect(e.subject).not.toMatch(/[\r\n]/);
    expect(e.subject).toBe("New photos from Eve Bcc: x@y.org: Nice Subject: hi <b>bold</b> (12 photos, 2 videos)");
    expect(e.replyTo?.name).toBe("Eve Bcc: x@y.org");
    expect(e.html).not.toContain("<b>");
    expect(e.html).toContain("&lt;b&gt;bold&lt;/b&gt;");
  });

  it("as the generic notice, says only what is known", () => {
    const e = composeEmail({ kind: "unknown", submissionId: "abcdefghjkmn", sent: { photos: 0, videos: 0 } }, BASE);
    expect(e.subject).toBe("An incomplete Submission may be ready for review");
    expect(e.text).toContain("Submission ID: abcdefghjkmn");
    expect(e.text).toContain(reviewLink(BASE, "abcdefghjkmn"));
    expect(e.text).not.toContain("From:");
    expect(e.replyTo).toBeUndefined();
  });
});
