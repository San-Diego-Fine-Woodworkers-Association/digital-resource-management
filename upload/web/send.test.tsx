// The hand-off as the page drives it (#55): the service may answer
// "finishing" at once for a big video, and the page then polls the Item's
// status until ResourceSpace has it. When the connection drops it says so
// and stops, and the page tries again on its schedule (#58). The service's
// answers are faked.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSender, failureOf, handOver } from "./send.ts";

const ID = "0123456789abcdef0123456789abcdef";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Fakes the service: the hand-off answers `post`, then each poll answers the next of `polls`. */
function service(post: Response | Error, ...polls: (Response | Error)[]) {
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const reply = init?.method === "POST" ? post : polls.shift();
    if (!reply) throw new Error(`unexpected ${String(url)}`);
    if (reply instanceof Error) throw reply;
    return reply;
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("handing an arrived file over", () => {
  it("is done when the service answers sent", async () => {
    const fetch = service(json(200, { status: "sent" }));
    expect(await handOver({ uploadId: ID }, 1)).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/upload/api/items");
    expect(JSON.parse(String(init!.body))).toEqual({ uploadId: ID });
  });

  it("names the Item, so the service writes its own answers from Step 3 (#57)", async () => {
    const fetch = service(json(200, { status: "sent" }));
    expect(await handOver({ uploadId: ID, item: "7" }, 1)).toEqual({ ok: true });
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ uploadId: ID, item: "7" });
  });

  it("polls the Item's status while the service is finishing, until it is sent", async () => {
    const fetch = service(
      json(202, { status: "finishing" }),
      json(200, { status: "finishing" }),
      json(200, { status: "finishing" }),
      json(200, { status: "sent" }),
    );
    expect(await handOver({ uploadId: ID }, 1)).toEqual({ ok: true });
    expect(fetch.mock.calls.slice(1).map(([url]) => url)).toEqual(Array(3).fill(`/upload/api/items/${ID}`));
  });

  it("says the connection dropped when a poll goes unanswered, so the page can try again (#58)", async () => {
    service(json(202, { status: "finishing" }), json(200, { status: "finishing" }), new TypeError("network"));
    expect(await handOver({ uploadId: ID }, 1)).toEqual({ ok: false, reason: "connection" });
  });

  it("says the connection dropped when it drops while waiting for the answer (#58)", async () => {
    const fetch = service(new TypeError("network"));
    expect(await handOver({ uploadId: ID }, 1)).toEqual({ ok: false, reason: "connection" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("says the connection dropped when something in front of the service answers instead (#58)", async () => {
    service(json(202, { status: "finishing" }), new Response("Bad Gateway", { status: 502 }));
    expect(await handOver({ uploadId: ID }, 1)).toEqual({ ok: false, reason: "connection" });
  });

  it("asks again when the service restarted before it began the hand-off (#58)", async () => {
    service(json(202, { status: "finishing" }), json(200, { status: "arrived" }));
    expect(await handOver({ uploadId: ID }, 1)).toEqual({ ok: false, reason: "connection" });
  });

  it("tells the page once the service says it is on it, and not before", async () => {
    const answered = vi.fn();
    service(json(202, { status: "finishing" }), json(200, { status: "sent" }));
    expect(await handOver({ uploadId: ID }, 1, answered)).toEqual({ ok: true });
    expect(answered).toHaveBeenCalledTimes(1);

    const notAnswered = vi.fn();
    service(new TypeError("network"));
    await handOver({ uploadId: ID }, 1, notAnswered);
    expect(notAnswered).not.toHaveBeenCalled();
  });

  it("gives the reason when the service refused the file while finishing", async () => {
    service(json(202, { status: "finishing" }), json(200, { status: "refused", error: "too_many_videos" }));
    expect(await handOver({ uploadId: ID }, 1)).toEqual({ ok: false, reason: "too_many_videos" });
  });

  it.each([
    ["ResourceSpace did not take it", json(200, { status: "not_saved" })],
    ["the upload is gone", json(404, { error: "not_found" })],
  ])("can be tried again when %s", async (_, poll) => {
    service(json(202, { status: "finishing" }), poll);
    expect(await handOver({ uploadId: ID }, 1)).toEqual({ ok: false, reason: "failed" });
  });

  it("passes a refusal from the hand-off straight on", async () => {
    service(json(415, { error: "wrong_type" }));
    expect(await handOver({ uploadId: ID }, 1)).toEqual({ ok: false, reason: "wrong_type" });
  });

  it.each([
    ["rate_limited", 429],
    ["busy", 503],
    ["unavailable", 503],
    ["too_many_at_once", 429],
    ["too_much_staged", 429],
  ])("says the service is busy when it answers %s (#60)", async (error, status) => {
    service(json(status, { error }));
    expect(await handOver({ uploadId: ID }, 1)).toEqual({ ok: false, reason: "busy" });
  });
});

describe("why a request stopped (#58)", () => {
  it.each([
    [0, "", "connection"],
    [502, "Bad Gateway", "connection"],
    [503, "", "connection"],
    [504, "Gateway Timeout", "connection"],
    [503, JSON.stringify({ error: "unavailable" }), "busy"],
    [429, JSON.stringify({ error: "rate_limited" }), "busy"],
    [413, JSON.stringify({ error: "too_big" }), "too_big"],
    [502, JSON.stringify({ error: "not_saved" }), "failed"],
    // #59: the member, not the file: the page holds everything until they are back.
    [401, JSON.stringify({ error: "signed_out", signInUrl: "https://auth.example.org/login" }), "signed_out"],
    [403, JSON.stringify({ error: "not_member", renewUrl: "https://www.example.org/renew" }), "not_member"],
    // The kill switch turned on mid-send: busy, so the page keeps trying (#30, #59).
    [503, JSON.stringify({ error: "paused" }), "busy"],
    [401, "", "failed"],
    [403, JSON.stringify({ error: "forbidden" }), "failed"],
    [500, "", "failed"],
  ] as const)("%s %s is %s", (status, body, reason) => {
    expect(failureOf(status, body)).toBe(reason);
  });
});

describe("asking again who is signed in (#59)", () => {
  const answers = (reply: Response | Error) => {
    const fetch = vi.fn(async () => {
      if (reply instanceof Error) throw reply;
      return reply;
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
  };

  it("asks the service's session endpoint, never from the browser's cache", async () => {
    const fetch = answers(json(200, { user: { name: "Pat", email: "pat@example.org" } }));

    expect(await createSender().session()).toBe("signed_in");
    expect(fetch).toHaveBeenCalledWith("/upload/api/session", expect.objectContaining({ cache: "no-store" }));
  });

  it.each([
    [json(401, { error: "signed_out" }), "signed_out"],
    [json(403, { error: "not_member" }), "not_member"],
    [json(503, { error: "auth_unavailable" }), "unknown"],
    [new TypeError("Failed to fetch"), "unknown"],
  ] as const)("says %s as %s", async (reply, check) => {
    answers(reply);

    expect(await createSender().session()).toBe(check);
  });

  it("says when Send finds the member signed out, so nothing is lost", async () => {
    answers(json(401, { error: "signed_out" }));

    expect(await createSender().begin({ expectedItems: 1, details: {} as never, rightsConfirmed: true })).toEqual({
      ok: false,
      reason: "signed_out",
    });
  });
});
