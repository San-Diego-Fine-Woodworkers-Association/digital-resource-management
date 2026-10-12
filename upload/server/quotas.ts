// What one member may have going at once, and send in a day (#23, #60), so
// one person, by mistake or on purpose, cannot fill the staging volume or keep
// the service to themselves:
//
//   - at most 2 uploads receiving bytes at the same moment (the page sends two
//     at a time; a second tab waits its turn);
//   - at most 4 GB of their files on the staging volume at once, one
//     Submission's worth, counted as the bytes actually there, so a set the
//     phone gave up on halfway only counts for what arrived;
//   - at most 100 Items and 10 GB started in any 24 hours, and 50 Submissions.
//
// All held in memory and forgotten on a restart, as decided on #23: there is
// no database, and the global staging cap (staging.ts) still protects the
// disk. What is on staging is counted again at startup, from the uploads
// themselves.
//
// Each limit has its own refusal, answered with 429 and Retry-After, and each
// lifts by itself: a chunk finishing, a file handed over, or a day passing.
import type { Quotas as QuotaConfig } from "./config.ts";

export type QuotaRefusal = "too_many_at_once" | "too_much_staged" | "too_many_today" | "too_much_today";

export type QuotaCheck = { ok: true } | { refusal: QuotaRefusal; retryAfterS: number };

export interface Quotas {
  /** A new upload of `size` bytes: checks the member's day and staging, and counts it if it fits. */
  start(owner: string, uploadId: string, size: number): QuotaCheck;
  /**
   * A chunk of up to `incoming` bytes is about to arrive. If it may, the
   * upload counts as receiving until `done` is called.
   */
  write(owner: string, uploadId: string, incoming: number): { done: () => void } | { refusal: QuotaRefusal; retryAfterS: number };
  /** How many bytes of the upload are now on staging. */
  progress(uploadId: string, offset: number): void;
  /** The upload is gone from staging. What never arrived is given back to the member's day. */
  removed(uploadId: string): void;
  /** An upload found on staging at startup, counted as staged again. */
  restore(owner: string, uploadId: string, size: number, offset: number): void;
  /** A new Submission: counts it if the member has not started too many today. */
  startSubmission(owner: string): QuotaCheck;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/** A chunk is at most a few MB and Traefik gives each request 60 seconds. */
const AT_ONCE_RETRY_S = 15;
/** Files leave staging as they are handed over, a few seconds each (minutes for a long video). */
const STAGED_RETRY_S = 60;

interface Staged {
  owner: string;
  size: number;
  offset: number;
}

interface Started {
  at: number;
  uploadId: string;
  /** Declared at the start; what never arrived is taken off again when the upload goes. */
  bytes: number;
}

export function createQuotas(config: QuotaConfig, now: () => number = Date.now): Quotas {
  const staged = new Map<string, Staged>();
  const receiving = new Map<string, Set<string>>();
  const days = new Map<string, Started[]>();
  const submissionDays = new Map<string, number[]>();

  /** The member's uploads started in the last 24 hours, oldest first; older ones are dropped. */
  function today(owner: string): Started[] {
    const cutoff = now() - DAY_MS;
    const list = (days.get(owner) ?? []).filter((s) => s.at > cutoff);
    if (list.length) days.set(owner, list);
    else days.delete(owner);
    return list;
  }

  function stagedBytes(owner: string): number {
    let bytes = 0;
    for (const s of staged.values()) if (s.owner === owner) bytes += s.offset;
    return bytes;
  }

  /** Seconds until `at` is 24 hours old, at least 1. */
  const untilOld = (at: number) => Math.max(1, Math.ceil((at + DAY_MS - now()) / 1000));

  return {
    start(owner, uploadId, size) {
      const list = today(owner);
      if (list.length >= config.dailyItems) {
        // Room again once enough of the day's uploads are a day old.
        return { refusal: "too_many_today", retryAfterS: untilOld(list[list.length - config.dailyItems]!.at) };
      }
      let bytes = list.reduce((sum, s) => sum + s.bytes, 0);
      if (bytes + size > config.dailyBytes) {
        let at = now();
        for (const s of list) {
          bytes -= s.bytes;
          at = s.at;
          if (bytes + size <= config.dailyBytes) break;
        }
        return { refusal: "too_much_today", retryAfterS: untilOld(at) };
      }
      if (stagedBytes(owner) + size > config.stagedBytes) return { refusal: "too_much_staged", retryAfterS: STAGED_RETRY_S };
      list.push({ at: now(), uploadId, bytes: size });
      days.set(owner, list);
      staged.set(uploadId, { owner, size, offset: 0 });
      return { ok: true };
    },

    write(owner, uploadId, incoming) {
      const mine = receiving.get(owner) ?? new Set<string>();
      if (!mine.has(uploadId) && mine.size >= config.uploadsAtOnce) {
        return { refusal: "too_many_at_once", retryAfterS: AT_ONCE_RETRY_S };
      }
      const s = staged.get(uploadId);
      const chunk = s ? Math.max(0, Math.min(incoming, s.size - s.offset)) : incoming;
      if (stagedBytes(owner) + chunk > config.stagedBytes) return { refusal: "too_much_staged", retryAfterS: STAGED_RETRY_S };
      // Counted as there from now: the member may hear the chunk arrived
      // before `progress` says how much really did.
      if (s) s.offset += chunk;
      mine.add(uploadId);
      receiving.set(owner, mine);
      return {
        done() {
          mine.delete(uploadId);
          if (mine.size === 0 && receiving.get(owner) === mine) receiving.delete(owner);
        },
      };
    },

    progress(uploadId, offset) {
      const s = staged.get(uploadId);
      if (s) s.offset = offset;
    },

    removed(uploadId) {
      const s = staged.get(uploadId);
      if (!s) return;
      staged.delete(uploadId);
      const started = days.get(s.owner)?.find((d) => d.uploadId === uploadId);
      if (started && s.offset < s.size) started.bytes -= s.size - s.offset;
    },

    restore(owner, uploadId, size, offset) {
      staged.set(uploadId, { owner, size, offset });
    },

    startSubmission(owner) {
      const cutoff = now() - DAY_MS;
      const list = (submissionDays.get(owner) ?? []).filter((at) => at > cutoff);
      if (list.length >= config.dailySubmissions) {
        submissionDays.set(owner, list);
        return { refusal: "too_many_today", retryAfterS: untilOld(list[list.length - config.dailySubmissions]!) };
      }
      list.push(now());
      submissionDays.set(owner, list);
      return { ok: true };
    },
  };
}
