// The page telling the service it is done with a Submission (#61), so the
// Reviewers' email goes at once. Best-effort: nothing it answers, or a
// connection that is not there, reaches the member.
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportFinished } from "./send.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("telling the service the page finished", () => {
  it("posts to the Submission's finished address, as JSON, and keeps going if the tab closes", () => {
    const fetch = vi.fn(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetch);
    reportFinished("abcdefghjkmn");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/upload/api/submissions/abcdefghjkmn/finished");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", keepalive: true, body: "{}" });
    expect(init.headers).toEqual({ "content-type": "application/json" });
  });

  it("never throws, whatever happens", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
    expect(() => reportFinished("abcdefghjkmn")).not.toThrow();
    vi.stubGlobal("fetch", () => {
      throw new TypeError("blocked");
    });
    expect(() => reportFinished("abcdefghjkmn")).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
