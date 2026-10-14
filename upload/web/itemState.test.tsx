// The Item state rules (#58) on their own; SendMedia.test.tsx covers them on the page.
import { describe, expect, it } from "vitest";
import {
  canStart,
  canTryAgain,
  isBusyTrouble,
  isSettled,
  nextState,
  RETRY_DELAYS_MS,
  retryDelay,
  WAITING,
  type ItemEvent,
  type ItemState,
} from "./itemState.ts";

const run = (state: ItemState, ...events: ItemEvent[]) => events.reduce(nextState, state);
const dropped: ItemEvent = { type: "result", result: { ok: false, reason: "connection" } };
const retry: ItemEvent[] = [{ type: "retryDue" }, { type: "start" }, dropped];

describe("Item states", () => {
  it("go Waiting, Sending, Finishing up, Sent", () => {
    expect(
      run(WAITING, { type: "start" }, { type: "progress", percent: 50 }, { type: "finishing" }, { type: "result", result: { ok: true } }),
    ).toEqual({ status: "sent" });
  });

  it("follow the schedule of automatic tries, then wait for the member", () => {
    let state = run(WAITING, { type: "start" }, dropped);
    const delays: (number | undefined)[] = [];
    while (state.status === "connection") {
      delays.push(retryDelay(state));
      state = run(state, ...retry);
    }
    expect(delays).toEqual([...RETRY_DELAYS_MS]);
    expect(delays.reduce((a = 0, b = 0) => a + b, 0)).toBe(104_000 + 10 * 60_000);
    expect(state).toEqual({ status: "stalled" });
    expect(canTryAgain(state) && isSettled(state)).toBe(true);
    expect(run(state, { type: "tryAgain" })).toEqual(WAITING);
  });

  it("start the schedule over once the service answers", () => {
    const state = run(WAITING, { type: "start" }, dropped, ...retry, ...retry);
    expect(retryDelay(state)).toBe(10_000);
    const answered = run(state, { type: "retryDue" }, { type: "start" }, { type: "progress", percent: 70 }, dropped);
    expect(retryDelay(answered)).toBe(1000);
  });

  it("only start a try once it is due", () => {
    const pausing = run(WAITING, { type: "start" }, dropped);
    expect(canStart(pausing)).toBe(false);
    expect(run(pausing, { type: "start" })).toBe(pausing);
    expect(canStart(run(pausing, { type: "retryDue" }))).toBe(true);
  });

  it("ignore what comes late: progress after the end, a result for one not being sent, Try again while it works", () => {
    const sent: ItemState = { status: "sent" };
    expect(run(sent, { type: "progress", percent: 10 }, { type: "finishing" }, dropped)).toBe(sent);
    const pausing = run(WAITING, { type: "start" }, dropped);
    expect(run(pausing, { type: "result", result: { ok: true } })).toBe(pausing);
    expect(run(pausing, { type: "tryAgain" })).toBe(pausing);
  });

  it.each([
    ["failed", { status: "failed" }],
    ["too_big", { status: "refused", refusal: "too_big" }],
    // #59: the member's session, not the file: it waits to go again from where it stopped.
    ["signed_out", WAITING],
    ["not_member", WAITING],
  ] as const)("map a %s result to its state", (reason, state) => {
    expect(run(WAITING, { type: "start" }, { type: "result", result: { ok: false, reason } })).toEqual(state);
  });

  it("offer Try again for Couldn't save and Busy, but never for one that can't be added", () => {
    expect(canTryAgain({ status: "failed" })).toBe(true);
    expect(canTryAgain({ status: "busy" })).toBe(true);
    expect(canTryAgain({ status: "refused", refusal: "wrong_type" })).toBe(false);
    expect(run({ status: "refused", refusal: "wrong_type" }, { type: "tryAgain" })).toEqual({ status: "refused", refusal: "wrong_type" });
  });

  it("put a busy one on the same schedule, marked busy, and Busy with Try again once it runs out (#59)", () => {
    const busy: ItemEvent = { type: "result", result: { ok: false, reason: "busy" } };
    let state = run(WAITING, { type: "start" }, busy);
    expect(state).toEqual({ status: "connection", tries: 1, phase: "pausing", busy: true });
    expect(isBusyTrouble(state)).toBe(true);
    const delays: (number | undefined)[] = [];
    while (state.status === "connection") {
      delays.push(retryDelay(state));
      state = run(state, { type: "retryDue" }, { type: "start" }, busy);
    }
    expect(delays).toEqual([...RETRY_DELAYS_MS]);
    expect(state).toEqual({ status: "busy" });
    expect(canTryAgain(state)).toBe(true);
    // The connection dropping on a busy one's try is Connection trouble again.
    expect(isBusyTrouble(run(WAITING, { type: "start" }, busy, ...retry))).toBe(false);
  });

  it("make every automatic try due at once on resume, and one more for Waiting for your connection (#59)", () => {
    const pausing = run(WAITING, { type: "start" }, dropped, ...retry);
    const resumed = run(pausing, { type: "resume" });
    expect(resumed).toEqual({ status: "connection", tries: 2, phase: "due" });
    expect(canStart(resumed)).toBe(true);

    const stalled: ItemState = { status: "stalled" };
    const again = run(stalled, { type: "resume" });
    expect(canStart(again)).toBe(true);
    expect(run(again, { type: "start" }, dropped)).toEqual(stalled);

    // Nothing else moves: not one sending, nor one that needs the member.
    for (const state of [WAITING, { status: "sending", percent: 5 }, { status: "failed" }, { status: "busy" }] as ItemState[]) {
      expect(run(state, { type: "resume" })).toBe(state);
    }
    const trying = run(pausing, { type: "retryDue" }, { type: "start" });
    expect(run(trying, { type: "resume" })).toBe(trying);
  });
});
