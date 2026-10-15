// Telling the Reviewers (#61, #32, ADR 0006): at most one email per
// Submission, best-effort, never in the member's way.
//
// When it goes:
//   - scheduled when a Submission starts;
//   - complete, at once, when every Item the page said it would send is in
//     ResourceSpace;
//   - partial ("9 of 14 sent"), at once, when the page says it finished with
//     some not sent (POST /submissions/<id>/finished);
//   - partial, when nothing has arrived for the stall time (30 minutes). The
//     deadline slides forward with every chunk, hand-off and Item, so a slow
//     but healthy upload never trips it. If none at all arrived, there is
//     nothing to review and nothing is sent.
// Once it has gone, nothing sends another: Items that arrive later are in
// Pending Review without a second email.
//
// The generic notice ("an incomplete Submission may be ready for review"):
// the email needs the Submission's record (the Step 2 answers and how many
// were expected). The sweep never removes a record while its email waits, so
// the record is only missing or unreadable if staging was damaged or edited
// by hand while the email waited: the record file removed or corrupted, a
// write that never landed, or a backup restored without it. Its own state
// file damaged the same way counts too. The id, and who sent it, are still
// known, so the notice links to what arrived.
//
// State. Each Submission's email has a small state file on staging,
// `<submission id>.notify.json`: who started it (from the verified session),
// whether the page said it finished, which uploads have arrived in
// ResourceSpace, and whether the email has gone. The clock is kept only in
// memory. At startup every state file still pending is read back, the
// arrivals are checked against the Items' own records (`<upload id>.item.json`,
// items.ts), and then: complete, or finished, sends at once; anything else
// gets a fresh stall deadline from now (while the service was down the page
// could not get through, so that is not counted as no progress).
//
// The email is marked sent as soon as the relay accepts it. A crash between
// the two may send it again once after the restart: a rare duplicate is
// accepted over a lost email (#61 decision 5). A failed send is tried again
// up to 3 times with growing pauses, then logged in the audit trail and
// given up; the member never sees any of it.
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Details } from "../shared/details.ts";
import type { MediaKind } from "../shared/media.ts";
import type { AuditLog } from "./audit.ts";
import { isSubmissionId } from "./naming.ts";
import { composeEmail, type EmailFacts, type Mailer } from "./reviewer-email.ts";
import type { SubmissionRecord } from "./submissions.ts";

/** The pauses before each of the 3 tries after a failed send. */
export const EMAIL_RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000];

/** How long a sent email is remembered in memory (its state file goes with the staging sweep). */
const REMEMBER_FOR_MS = 24 * 60 * 60 * 1000;

const STATE = /^([a-z0-9]{12})\.notify\.json$/;
const ITEM = /^[0-9a-f]{32}\.item\.json$/;

/** What is kept on staging for each Submission's email. */
export interface NotifyState {
  submissionId: string;
  /** The session user id of the member who started it. */
  owner: string;
  /** Their name and email, for the email and its Reply-To. */
  submitter: { name: string; email: string };
  status: "pending" | "sent" | "gave_up";
  /** The page said it finished with some not sent. */
  finished?: boolean;
  /** What has arrived in ResourceSpace, by upload id. */
  sent: Record<string, MediaKind>;
  /** What went (or why nothing did), and when. */
  outcome?: string;
  doneAt?: string;
}

interface Entry {
  state: NotifyState;
  /** The Submission's record; undefined when it could not be read. */
  record?: SubmissionRecord;
  /** The state file itself could not be read: only the id is known. */
  damaged?: boolean;
  deadline: number;
  timer?: ReturnType<typeof setTimeout>;
  /** An email is being sent (or retried) now. */
  sending?: boolean;
  doneAt?: number;
}

export interface Notifier {
  /** At startup: reads back every pending email and arms it again. */
  load(): Promise<void>;
  /** A Submission has started: its email is scheduled. */
  started(record: SubmissionRecord, submitter: { name: string; email: string }): Promise<void>;
  /** Something arrived for it (a chunk, or a hand-off under way): the stall deadline moves on. */
  progress(submissionId: string): void;
  /** An Item is in ResourceSpace. Sends the complete email if it was the last one. */
  itemSent(submissionId: string, uploadId: string, kind: MediaKind): Promise<void>;
  /** The page says it finished with some not sent. Only the member who started it may say so. */
  finished(submissionId: string, owner: string): Promise<"ok" | "not_found">;
  /** Whether its email is still to go: its record must stay on staging (the sweep). */
  pending(submissionId: string): boolean;
  /** Sends whatever stalled email is due now. The timers call it; tests too, after moving the clock on. */
  check(): void;
  /** Resolves once nothing is being sent or written (tests). */
  idle(): Promise<void>;
  close(): void;
}

export function createNotifier(deps: {
  dir: string;
  stallMs: number;
  publicBaseUrl: string;
  mailer: Mailer;
  audit: AuditLog;
  /** The Submission's record from staging, as written when it started. */
  readRecord: (submissionId: string, owner: string) => Promise<SubmissionRecord | undefined>;
  log: (message: string, fields?: Record<string, unknown>) => void;
  now?: () => number;
  retryDelaysMs?: number[];
}): Notifier {
  const { dir, stallMs, mailer, audit, log } = deps;
  const now = deps.now ?? Date.now;
  const retryDelaysMs = deps.retryDelaysMs ?? EMAIL_RETRY_DELAYS_MS;
  const all = new Map<string, Entry>();
  /** Writes per Submission, one after another, so a later state never loses to an earlier one. */
  const writes = new Map<string, Promise<void>>();
  const busy = new Set<Promise<unknown>>();
  let closed = false;

  const statePath = (id: string) => path.join(dir, `${id}.notify.json`);

  function track<T>(p: Promise<T>): Promise<T> {
    busy.add(p);
    void p.finally(() => busy.delete(p)).catch(() => {});
    return p;
  }

  function save(entry: Entry): Promise<void> {
    const id = entry.state.submissionId;
    const snapshot = JSON.stringify(entry.state);
    const file = statePath(id);
    const next = (writes.get(id) ?? Promise.resolve()).then(async () => {
      try {
        await writeFile(`${file}.tmp`, snapshot, { mode: 0o600 });
        await rename(`${file}.tmp`, file);
      } catch (err) {
        log("could not save the reviewer email's state", { submissionId: id, error: message(err) });
      }
    });
    writes.set(id, next);
    void next.then(() => {
      if (writes.get(id) === next) writes.delete(id);
    });
    return track(next);
  }

  function forgetOld() {
    const cutoff = now() - REMEMBER_FOR_MS;
    for (const [id, e] of all) if (e.doneAt !== undefined && e.doneAt < cutoff) all.delete(id);
  }

  function arm(entry: Entry) {
    entry.deadline = now() + stallMs;
    if (entry.timer) clearTimeout(entry.timer);
    if (closed) return;
    entry.timer = setTimeout(() => check(), stallMs);
    entry.timer.unref?.();
  }

  const sentCount = (e: Entry) => Object.keys(e.state.sent).length;
  const isPending = (e: Entry | undefined): e is Entry => !!e && e.state.status === "pending" && !e.sending;

  /**
   * Whether this is the moment to send, and what: complete as soon as all
   * are in; partial when the page says it finished or it stalled; the
   * generic notice instead when the record is unknown.
   */
  function decide(e: Entry, reason: "item" | "finished" | "stalled"): void {
    if (!isPending(e)) return;
    const expected = e.record?.expectedItems;
    if (expected !== undefined && sentCount(e) >= expected) return send(e, "complete");
    if (reason === "item") return;
    if (!e.record) return send(e, "unknown", reason);
    if (sentCount(e) === 0) {
      // Nothing reached ResourceSpace: nothing to review. Only a stall gives up on it.
      if (reason === "stalled") {
        log("no reviewer email: nothing in the Submission arrived", { submissionId: e.state.submissionId });
        void finish(e, "gave_up", "nothing_sent");
      }
      return;
    }
    return send(e, "partial", reason);
  }

  function factsOf(e: Entry, kind: EmailFacts["kind"], reason?: "finished" | "stalled"): EmailFacts {
    const kinds = Object.values(e.state.sent);
    const videos = kinds.filter((k) => k === "video").length;
    const r = e.record;
    return {
      kind,
      submissionId: e.state.submissionId,
      ...(e.damaged ? {} : { submitter: e.state.submitter }),
      sent: { photos: kinds.length - videos, videos },
      ...(r && kind !== "unknown"
        ? { expectedItems: r.expectedItems, details: r.details, ownDetails: Object.keys(r.items ?? {}).length }
        : {}),
      ...(kind === "partial" && reason
        ? { why: reason === "finished" ? ({ finished: true } as const) : { stalledMinutes: Math.round(stallMs / 60_000) } }
        : {}),
    };
  }

  function send(e: Entry, kind: EmailFacts["kind"], reason?: "finished" | "stalled") {
    e.sending = true;
    if (e.timer) clearTimeout(e.timer);
    const id = e.state.submissionId;
    const email = composeEmail(factsOf(e, kind, reason), deps.publicBaseUrl);
    void track(
      (async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            await mailer(email);
            break;
          } catch (err) {
            const pause = retryDelaysMs[attempt];
            log("could not send the reviewer email", { submissionId: id, attempt: attempt + 1, error: message(err) });
            if (pause === undefined) {
              audit.record({ event: "reviewer_email", outcome: "failed", submissionId: id });
              await finish(e, "gave_up", `failed_${kind}`);
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, pause).unref?.());
            // Stopping: still pending on staging, so the next start sends it.
            if (closed) return;
          }
        }
        audit.record({ event: "reviewer_email", outcome: `sent_${kind}`, submissionId: id });
        await finish(e, "sent", kind);
      })(),
    );
  }

  async function finish(e: Entry, status: "sent" | "gave_up", outcome: string) {
    if (e.timer) clearTimeout(e.timer);
    e.sending = false;
    e.doneAt = now();
    e.damaged = false;
    e.state = { ...e.state, status, outcome, doneAt: new Date(e.doneAt).toISOString() };
    await save(e);
  }

  function check() {
    const t = now();
    for (const e of all.values()) if (isPending(e) && t >= e.deadline) decide(e, "stalled");
  }

  /** A state file as written by `save`, or undefined. */
  function parseState(id: string, raw: string): NotifyState | undefined {
    try {
      const s = JSON.parse(raw) as Partial<NotifyState>;
      if (s.submissionId !== id || typeof s.owner !== "string" || typeof s.status !== "string") return undefined;
      if (typeof s.submitter?.name !== "string" || typeof s.submitter.email !== "string") return undefined;
      if (typeof s.sent !== "object" || s.sent === null) return undefined;
      return s as NotifyState;
    } catch {
      return undefined;
    }
  }

  /** The record as written when it started, or undefined if it is gone or not one. */
  async function recordOf(state: NotifyState): Promise<SubmissionRecord | undefined> {
    const r = await deps.readRecord(state.submissionId, state.owner).catch(() => undefined);
    return r && isRecordShape(r, state.submissionId) ? r : undefined;
  }

  return {
    async load() {
      const names = await readdir(dir);
      const pending: Entry[] = [];
      for (const name of names) {
        const id = STATE.exec(name)?.[1];
        if (!id || !isSubmissionId(id) || all.has(id)) continue;
        const raw = await readFile(path.join(dir, name), "utf8").catch(() => undefined);
        const state = raw === undefined ? undefined : parseState(id, raw);
        if (state && state.status !== "pending") {
          all.set(id, { state, deadline: Infinity, doneAt: now() });
          continue;
        }
        const entry: Entry = state
          ? { state, deadline: 0 }
          : // Its own state is damaged: only the id is known. Treated as pending, so nothing is lost.
            { state: { submissionId: id, owner: "", submitter: { name: "", email: "" }, status: "pending", sent: {} }, deadline: 0, damaged: true };
        if (state) entry.record = await recordOf(state);
        all.set(id, entry);
        pending.push(entry);
      }
      if (pending.length === 0) return;
      // What arrived while the state was not written (a crash between the two).
      for (const name of names) {
        if (!ITEM.test(name)) continue;
        try {
          const item = JSON.parse(await readFile(path.join(dir, name), "utf8")) as { submissionId?: unknown; sent?: unknown; kind?: unknown };
          const e = typeof item.submissionId === "string" ? all.get(item.submissionId) : undefined;
          if (e && item.sent === true && (item.kind === "photo" || item.kind === "video")) e.state.sent[name.slice(0, 32)] = item.kind;
        } catch {
          // not readable: it does not count
        }
      }
      for (const e of pending) {
        log("reviewer email still to send after a restart", { submissionId: e.state.submissionId, known: !!e.record });
        arm(e);
        if (e.state.finished) decide(e, "finished");
        else decide(e, "item");
      }
    },

    async started(record, submitter) {
      forgetOld();
      const entry: Entry = {
        state: {
          submissionId: record.submissionId,
          owner: record.owner,
          submitter: { name: submitter.name, email: submitter.email },
          status: "pending",
          sent: {},
        },
        record,
        deadline: 0,
      };
      all.set(record.submissionId, entry);
      arm(entry);
      await save(entry);
    },

    progress(submissionId) {
      const e = all.get(submissionId);
      if (isPending(e)) arm(e);
    },

    async itemSent(submissionId, uploadId, kind) {
      const e = all.get(submissionId);
      if (!isPending(e) || e.state.sent[uploadId]) return;
      e.state.sent[uploadId] = kind;
      arm(e);
      await save(e);
      decide(e, "item");
    },

    async finished(submissionId, owner) {
      const e = all.get(submissionId);
      if (!e || e.damaged || e.state.owner !== owner) return "not_found";
      if (!isPending(e) || e.state.finished) return "ok";
      e.state.finished = true;
      await save(e);
      decide(e, "finished");
      return "ok";
    },

    pending(submissionId) {
      const e = all.get(submissionId);
      return !!e && e.state.status === "pending";
    },

    check,

    async idle() {
      while (busy.size > 0) await Promise.allSettled([...busy]);
    },

    close() {
      closed = true;
      for (const e of all.values()) if (e.timer) clearTimeout(e.timer);
    },
  };
}

/** A notifier that does nothing: the kill switch (REVIEWER_EMAIL_PAUSED). */
export const pausedNotifier: Notifier = {
  load: async () => {},
  started: async () => {},
  progress: () => {},
  itemSent: async () => {},
  finished: async () => "ok",
  pending: () => false,
  check: () => {},
  idle: async () => {},
  close: () => {},
};

function isRecordShape(r: SubmissionRecord, id: string): boolean {
  const d = r.details as Partial<Details> | undefined;
  return (
    r.submissionId === id &&
    Number.isInteger(r.expectedItems) &&
    r.expectedItems > 0 &&
    typeof d === "object" &&
    d !== null &&
    typeof d.title === "string" &&
    typeof d.programevent === "string" &&
    Array.isArray(d.subjecttype) &&
    typeof d.date === "string" &&
    typeof d.location === "string" &&
    typeof d.eventname === "string" &&
    typeof d.caption === "string"
  );
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
