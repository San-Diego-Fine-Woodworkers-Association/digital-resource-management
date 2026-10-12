// The hand-off as the page drives it (#55): the service may answer
// "finishing" at once for a big video, and the page then polls the Item's
// status until ResourceSpace has it. The service's answers are faked.
import { afterEach, describe, expect, it, vi } from "vitest";
import { handOver } from "./send.ts";

const ID = "0123456789abcdef0123456789abcdef";
const DETAILS = { title: "Dovetail class, May 3", rightsConfirmed: true } as const;

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
    expect(await handOver(ID, DETAILS, 1)).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("/upload/api/items");
    expect(JSON.parse(String(init!.body))).toEqual({ uploadId: ID, ...DETAILS });
  });

  it("polls the Item's status while the service is finishing, until it is sent", async () => {
    const fetch = service(
      json(202, { status: "finishing" }),
      json(200, { status: "finishing" }),
      json(200, { status: "finishing" }),
      json(200, { status: "sent" }),
    );
    expect(await handOver(ID, DETAILS, 1)).toEqual({ ok: true });
    expect(fetch.mock.calls.slice(1).map(([url]) => url)).toEqual(Array(3).fill(`/upload/api/items/${ID}`));
  });

  it("rides out a few unanswered polls (a blip in the connection)", async () => {
    service(
      json(202, { status: "finishing" }),
      new TypeError("network"),
      json(503, { error: "auth_unavailable" }),
      json(200, { status: "sent" }),
    );
    expect(await handOver(ID, DETAILS, 1)).toEqual({ ok: true });
  });

  it("asks how it went when the connection drops while waiting for the answer", async () => {
    service(new TypeError("network"), json(200, { status: "finishing" }), json(200, { status: "sent" }));
    expect(await handOver(ID, DETAILS, 1)).toEqual({ ok: true });
  });

  it("gives the reason when the service refused the file while finishing", async () => {
    service(json(202, { status: "finishing" }), json(200, { status: "refused", error: "too_many_videos" }));
    expect(await handOver(ID, DETAILS, 1)).toEqual({ ok: false, reason: "too_many_videos" });
  });

  it.each([
    ["ResourceSpace did not take it", json(200, { status: "not_saved" })],
    ["the service has forgotten the hand-off", json(200, { status: "arrived" })],
    ["the upload is gone", json(404, { error: "not_found" })],
  ])("can be tried again when %s", async (_, poll) => {
    service(json(202, { status: "finishing" }), poll);
    expect(await handOver(ID, DETAILS, 1)).toEqual({ ok: false, reason: "failed" });
  });

  it("stops asking after about a minute without an answer", async () => {
    const fetch = service(json(202, { status: "finishing" }), ...Array.from({ length: 30 }, () => new TypeError("network")));
    expect(await handOver(ID, DETAILS, 1)).toEqual({ ok: false, reason: "failed" });
    expect(fetch).toHaveBeenCalledTimes(1 + 20);
  });

  it("passes a refusal from the hand-off straight on", async () => {
    service(json(415, { error: "wrong_type" }));
    expect(await handOver(ID, DETAILS, 1)).toEqual({ ok: false, reason: "wrong_type" });
  });
});
