// Where each Item is while the page sends it, and what moves it on (#58, #30).
//
// Six states a member can see, each with at most one thing to do:
//   Sending             chunks going up                       nothing needed
//   Finishing up        the service is handing it over        nothing needed
//   Sent                in ResourceSpace                       nothing needed
//   Connection trouble  tried again by itself on a schedule;   Try again (once
//                       when that runs out, "Waiting for your  it is waiting)
//                       connection"
//   Can't be added      the service will never take it         Remove
//   Couldn't save       ResourceSpace failed, after the        Try again
//                       service's own retries
// plus Waiting (its turn has not come; two are sent at a time) and Busy (the
// service can't take it just now, #60).
//
// This is only the rules; SendMedia.tsx keeps the timers and the queue. Every
// Item has its own state, so one that fails never holds up the rest.
//
// The interruptions (#59) add to it: a busy service takes the same schedule
// as Connection trouble (marked `busy`, so the page can say so and hold the
// rest of the queue), and when the schedule runs out it is Busy, with Try
// again. Signed out or no longer a member puts the Item back to Waiting: the
// page holds the queue until the member is back, then it resumes where it
// stopped. Coming back online or to the foreground is `resume`: every Item in
// Connection trouble or Waiting for your connection is due at once. While
// the page is held (offline, signed out) it simply starts nothing and runs no
// timers, so there is no `pause` event.
import type { Refusal } from "../shared/media.ts";
import type { SendResult } from "./send.ts";

/**
 * The pauses before each automatic try after the connection drops: about 1,
 * 3, 10, 30 and 60 seconds, then every minute for about 10 minutes. After the
 * last one the Item waits for the member's Try again.
 */
export const RETRY_DELAYS_MS: readonly number[] = [1000, 3000, 10_000, 30_000, 60_000, ...Array<number>(10).fill(60_000)];

export type ItemState =
  | { status: "waiting" }
  | { status: "sending"; percent: number }
  | { status: "finishing" }
  | { status: "sent" }
  /**
   * Connection trouble: `tries` is which automatic try comes next (1 for the
   * first) since the service last answered. "pausing" until that try is due, "due" while it waits for
   * a free place in the queue, "trying" while that try runs. `busy` when
   * the service said it is busy, not the connection (#59).
   */
  | { status: "connection"; tries: number; phase: "pausing" | "due" | "trying"; busy?: true }
  /** Connection trouble after every automatic try: Waiting for your connection. */
  | { status: "stalled" }
  /** Couldn't save. */
  | { status: "failed" }
  /** The service can't take it just now (#60). */
  | { status: "busy" }
  /** Can't be added. */
  | { status: "refused"; refusal: Refusal };

export type ItemEvent =
  /** A send begins: its turn came, or its next automatic try. */
  | { type: "start" }
  /** Some of the file reached the service. */
  | { type: "progress"; percent: number }
  /** All of it is there and the service is handing it over. */
  | { type: "finishing" }
  | { type: "result"; result: SendResult }
  /** The pause before the next automatic try is over. */
  | { type: "retryDue" }
  /** The member pressed Try again. */
  | { type: "tryAgain" }
  /** Back online or in the foreground (#59): every automatic try is due now. */
  | { type: "resume" };

export const WAITING: ItemState = { status: "waiting" };

export function nextState(state: ItemState, event: ItemEvent): ItemState {
  switch (event.type) {
    case "start":
      if (state.status === "waiting") return { status: "sending", percent: 0 };
      // Still Connection trouble until the service answers.
      if (state.status === "connection" && state.phase === "due") return { ...state, phase: "trying" };
      return state;

    case "progress":
      // Any answer from the service ends the trouble, and the schedule starts over next time.
      if (state.status === "sending" || isTrying(state)) return { status: "sending", percent: event.percent };
      return state;

    case "finishing":
      if (state.status === "sending" || isTrying(state)) return { status: "finishing" };
      return state;

    case "result": {
      if (!isActive(state)) return state;
      const { result } = event;
      if (result.ok) return { status: "sent" };
      switch (result.reason) {
        case "connection":
        case "busy": {
          // The first trouble starts the schedule; each failed try moves along it.
          const busy = result.reason === "busy" ? ({ busy: true } as const) : {};
          if (!isTrying(state)) return { status: "connection", tries: 1, phase: "pausing", ...busy };
          if (state.tries >= RETRY_DELAYS_MS.length) return result.reason === "busy" ? { status: "busy" } : { status: "stalled" };
          return { status: "connection", tries: state.tries + 1, phase: "pausing", ...busy };
        }
        case "signed_out":
        case "not_member":
          // Not this Item's trouble: it waits for the member to be back (#59).
          return WAITING;
        case "failed":
          return { status: "failed" };
        default:
          return { status: "refused", refusal: result.reason };
      }
    }

    case "retryDue":
      if (state.status === "connection" && state.phase === "pausing") return { ...state, phase: "due" };
      return state;

    case "tryAgain":
      if (state.status === "failed" || state.status === "stalled" || state.status === "busy") return WAITING;
      return state;

    case "resume":
      if (state.status === "connection" && state.phase !== "trying") return { ...state, phase: "due" };
      // One more try; if it fails it is waiting for the member again.
      if (state.status === "stalled") return { status: "connection", tries: RETRY_DELAYS_MS.length, phase: "due" };
      return state;
  }
}

function isTrying(state: ItemState): state is Extract<ItemState, { status: "connection" }> {
  return state.status === "connection" && state.phase === "trying";
}

/** A send is running for it. */
export function isActive(state: ItemState): boolean {
  return state.status === "sending" || state.status === "finishing" || isTrying(state);
}

/** It may start a send as soon as there is room: its turn, or its next automatic try. */
export function canStart(state: ItemState): boolean {
  return state.status === "waiting" || (state.status === "connection" && state.phase === "due");
}

/** How long until its next automatic try, if it is pausing before one. */
export function retryDelay(state: ItemState): number | undefined {
  if (state.status !== "connection" || state.phase !== "pausing") return undefined;
  return RETRY_DELAYS_MS[state.tries - 1];
}

/** Nothing more will happen to it unless the member acts: it is sent, or it needs them. */
export function isSettled(state: ItemState): boolean {
  return ["sent", "stalled", "failed", "busy", "refused"].includes(state.status);
}

/** Settled without being sent, and Try again may still send it. */
export function canTryAgain(state: ItemState): boolean {
  return state.status === "stalled" || state.status === "failed" || state.status === "busy";
}

/** The service said it is busy and the page is trying again by itself (#59). */
export function isBusyTrouble(state: ItemState): boolean {
  return state.status === "connection" && state.busy === true;
}
