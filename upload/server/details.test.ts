// Seam 1: the Step 2 answers (#56), through the service's HTTP boundary. The
// live choices for the list fields, the checks on a Submission's answers
// (ResourceSpace's API makes none, ADR 0003), the Submission record every Item
// is written from, and the read-back that confirms what was saved.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ANSWERS, client, jpeg, member, startBody } from "./testing/client.ts";
import { FAKE_OPTIONS } from "./testing/fake-rs.ts";
import { COOKIE, startHarness, type Harness } from "./testing/harness.ts";

let h: Harness;
afterEach(async () => h?.close());

const RIGHTS = "I took these, or I have permission to share them with SDFWA";

/** The service's JSON answer, in the shapes this file reads. */
interface Answer {
  error?: string;
  problems?: { field: string; problem: string }[];
  options?: Record<string, string[]>;
  submissionId?: string;
}
const answer = async (res: Response) => (await res.json()) as Answer;

const calls = (fn: string, field?: string) =>
  h.fakeRs.calls.filter((c) => c.fn === fn && (field === undefined || c.params.get("field") === field));

const only = () => {
  expect(h.fakeRs.resources.size).toBe(1);
  return [...h.fakeRs.resources.values()][0]!;
};

function option(field: string, name: string) {
  const o = h.fakeRs.options[field]!.find((x) => x.name === name);
  if (!o) throw new Error(`no option ${name}`);
  return o;
}

/** Starts a Submission with these answers, sends one photo into it and hands it over. */
async function send(details: Record<string, unknown> = {}) {
  const c = client(h);
  const submission = await c.startSubmission(COOKIE, startBody({ details }));
  return c.finish(await c.upload(jpeg(), { submission }));
}

describe("the live choices", () => {
  it("are what ResourceSpace offers now, in its order", async () => {
    h = await startHarness();
    h.auth.respond = member();

    const res = await client(h).options();

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ options: FAKE_OPTIONS });
    for (const field of ["programevent", "subjecttype", "location"]) {
      expect(calls("get_field_options").map((c) => c.params.get("ref"))).toContain(field);
    }
  });

  it("leave out a choice an administrator has deactivated", async () => {
    h = await startHarness();
    h.auth.respond = member();
    option("location", "Swap Meet").active = false;

    const options = (await answer(await client(h).options())).options!;

    expect(options.location).toEqual(["Shop", "Design in Wood", "Shop Tour"]);
  });

  it("follow ResourceSpace when an option is added or renamed there", async () => {
    h = await startHarness();
    h.auth.respond = member();
    h.fakeRs.options.programevent!.push({ name: "Toy Drive", active: true });
    option("location", "Shop").name = "The Shop";

    const options = (await answer(await client(h).options())).options!;

    expect(options.programevent).toContain("Toy Drive");
    expect(options.location?.[0]).toBe("The Shop");
  });

  it("are cached briefly, so each page load does not ask ResourceSpace again", async () => {
    h = await startHarness();
    h.auth.respond = member();

    await client(h).options();
    await client(h).options();

    expect(calls("get_field_options")).toHaveLength(3);
  });

  it("say plainly when ResourceSpace cannot be asked, and log it", async () => {
    h = await startHarness();
    h.auth.respond = member();
    h.fakeRs.failWhen = (c) => (c.fn === "get_field_options" ? { status: 500, body: "oops" } : undefined);

    const res = await client(h).options();

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
    expect(h.logLines.map((l) => l.message)).toContain("could not read the choices from ResourceSpace");
  });

  it("need a signed-in member", async () => {
    h = await startHarness();

    expect((await client(h).options()).status).toBe(401);
    expect(h.fakeRs.calls).toHaveLength(0);
  });
});

describe("starting a Submission checks the answers, because ResourceSpace's API does not", () => {
  it("refuses one without the three required answers, naming each", async () => {
    h = await startHarness();
    h.auth.respond = member();

    const res = await client(h).begin(
      startBody({ details: { title: "   ", programevent: "", subjecttype: [], caption: "Only a caption" } }),
    );

    expect(res.status).toBe(422);
    const body = await answer(res);
    expect(body.error).toBe("invalid_details");
    expect(body.problems).toEqual([
      { field: "title", problem: "required" },
      { field: "programevent", problem: "required" },
      { field: "subjecttype", problem: "required" },
    ]);
    expect(await readdir(h.stagingDir)).toEqual([]);
  });

  it("refuses one without the rights confirmation", async () => {
    h = await startHarness();
    h.auth.respond = member();

    for (const rightsConfirmed of [false, "yes", undefined]) {
      const res = await client(h).begin({ ...startBody(), rightsConfirmed });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "rights_required" });
    }
  });

  it.each([
    ["an occasion", { programevent: "Birthday party" }, "programevent"],
    ["a subject", { subjecttype: ["Finished Piece", "Cats"] }, "subjecttype"],
    ["a place", { location: "The moon" }, "location"],
  ])("refuses %s that is not one of the live choices, and sends the choices as they are now", async (_n, details, field) => {
    h = await startHarness();
    h.auth.respond = member();

    const res = await client(h).begin(startBody({ details }));

    expect(res.status).toBe(422);
    const body = await answer(res);
    expect(body.problems).toEqual([{ field, problem: "not_offered" }]);
    expect(body.options).toEqual(FAKE_OPTIONS);
    expect(h.fakeRs.resources.size).toBe(0);
  });

  it("refuses a choice ResourceSpace has deactivated", async () => {
    h = await startHarness();
    h.auth.respond = member();
    option("programevent", "Classes & Workshops").active = false;

    const res = await client(h).begin(startBody());

    expect(res.status).toBe(422);
    const body = await answer(res);
    expect(body.problems).toEqual([{ field: "programevent", problem: "not_offered" }]);
    expect(body.options!.programevent).not.toContain("Classes & Workshops");
  });

  it("takes a choice added since the choices were cached", async () => {
    h = await startHarness();
    h.auth.respond = member();
    await client(h).options();
    h.fakeRs.options.programevent!.push({ name: "Toy Drive", active: true });

    const res = await client(h).begin(startBody({ details: { programevent: "Toy Drive" } }));

    expect(res.status).toBe(201);
  });

  it.each([
    ["a date that is not a date", { date: "May 3" }, "date", "invalid"],
    ["a date that does not exist", { date: "2026-02-30" }, "date", "invalid"],
    ["a Title over 200 characters", { title: "x".repeat(201) }, "title", "too_long"],
    ["a class or event name over 200 characters", { eventname: "x".repeat(201) }, "eventname", "too_long"],
    ["a Caption over 2000 characters", { caption: "x".repeat(2001) }, "caption", "too_long"],
    ["subjects that are not names", { subjecttype: ["Finished Piece", 7] }, "subjecttype", "invalid"],
  ])("refuses %s", async (_n, details, field, problem) => {
    h = await startHarness();
    h.auth.respond = member();

    const res = await client(h).begin(startBody({ details }));

    expect(res.status).toBe(422);
    expect((await answer(res)).problems).toEqual([{ field, problem }]);
  });

  it.each([
    ["no count", { expectedItems: undefined }],
    ["none at all", { expectedItems: 0 }],
    ["more than one Submission takes", { expectedItems: 51 }],
    ["part of one", { expectedItems: 1.5 }],
  ])("refuses a count of photos and videos that is %s", async (_n, extra) => {
    h = await startHarness();
    h.auth.respond = member();

    const res = await client(h).begin({ ...startBody(), ...extra });

    expect(res.status).toBe(400);
  });

  it("says so, rather than guessing, when ResourceSpace cannot give the choices", async () => {
    h = await startHarness();
    h.auth.respond = member();
    h.fakeRs.failWhen = (c) => (c.fn === "get_field_options" ? { status: 502, body: "" } : undefined);

    const res = await client(h).begin(startBody());

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable" });
    expect(await readdir(h.stagingDir)).toEqual([]);
  });

  it("writes an audit line for a refused start, with the outcome", async () => {
    h = await startHarness();
    h.auth.respond = member();

    await client(h).begin(startBody({ details: { title: "" } }));

    const lines = h.auditLines.map((l) => JSON.parse(l));
    expect(lines.at(-1)).toMatchObject({ outcome: "invalid_details", path: "/upload/api/submissions" });
  });
});

describe("the Submission record", () => {
  it("has a server-made id and short code, the expected count, the checked answers and the rights confirmation", async () => {
    h = await startHarness();
    h.auth.respond = member();

    const res = await client(h).begin({
      ...startBody({
        expectedItems: 14,
        details: {
          title: "  Dovetail class, May 3 ",
          subjecttype: ["Finished Piece", "Work in Progress", "Finished Piece"],
          date: "2026-05-03",
          location: "Shop",
          eventname: "Hand-cut dovetails",
          caption: "Day one.\r\nDay two.",
        },
      }),
      // The page cannot choose these.
      submissionId: "chosenbyme12",
      code: "abcdef",
      owner: "u-1",
    });

    expect(res.status).toBe(201);
    const submissionId = (await answer(res)).submissionId!;
    expect(submissionId).toMatch(/^[a-z0-9]{12}$/);
    expect(submissionId).not.toBe("chosenbyme12");
    const record = JSON.parse(await readFile(path.join(h.stagingDir, `${submissionId}.submission.json`), "utf8"));
    expect(record).toEqual({
      submissionId,
      code: submissionId.slice(0, 6),
      owner: "u-42",
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      expectedItems: 14,
      details: {
        title: "Dovetail class, May 3",
        programevent: "Classes & Workshops",
        subjecttype: ["Finished Piece", "Work in Progress"],
        date: "2026-05-03",
        location: "Shop",
        eventname: "Hand-cut dovetails",
        caption: "Day one.\nDay two.",
      },
      rights: expect.stringMatching(new RegExp(`^Confirmed \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} PT: "${RIGHTS}"$`)),
    });
  });

  it("is what every Item in it is written from, each carrying the Submission ID the review link searches by", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const c = client(h);
    const submission = await c.startSubmission(
      COOKIE,
      startBody({ expectedItems: 3, details: { subjecttype: ["Finished Piece", "Tool or Equipment"], location: "Shop" } }),
    );

    for (let i = 0; i < 3; i++) expect((await c.finish(await c.upload(jpeg(), { submission }))).status).toBe(200);

    const all = [...h.fakeRs.resources.values()];
    expect(all).toHaveLength(3);
    for (const item of all) {
      expect(item.fields).toMatchObject({
        title: ANSWERS.title,
        programevent: "Classes & Workshops",
        subjecttype: "Finished Piece, Tool or Equipment",
        location: "Shop",
        submissionid: submission,
      });
    }
    expect(all.map((i) => i.file?.name)).toEqual([1, 2, 3].map((n) => `dovetail-class-may-3_${submission.slice(0, 6)}-00${n}.jpg`));
  });
});

describe("what reaches ResourceSpace", () => {
  it("every answer given, a multi-line Caption included", async () => {
    h = await startHarness();
    h.auth.respond = member();

    await send({
      date: "2026-05-03",
      location: "Design in Wood",
      eventname: "Design in Wood 2026",
      caption: "Pat's walnut desk.\nBest in show.",
    });

    expect(only().fields).toMatchObject({
      title: "Dovetail class, May 3",
      programevent: "Classes & Workshops",
      subjecttype: "Instruction / Class in Session",
      date: "2026-05-03",
      location: "Design in Wood",
      eventname: "Design in Wood 2026",
      caption: "Pat's walnut desk.\nBest in show.",
    });
  });

  it("never a blank Date (or any blank answer), so ResourceSpace keeps the date it read from the photo", async () => {
    h = await startHarness();
    h.auth.respond = member();

    await send({ date: "", location: "", eventname: "  ", caption: "" });

    for (const field of ["date", "location", "eventname", "caption"]) expect(calls("update_field", field)).toEqual([]);
    expect(only().fields).not.toHaveProperty("date");
  });

  it("a file name that starts with the member's Date when they gave one", async () => {
    h = await startHarness();
    h.auth.respond = member();

    await send({ date: "2026-05-03" });

    const item = only();
    expect(item.file?.name).toBe(`2026-05-03_dovetail-class-may-3_${item.fields.submissionid!.slice(0, 6)}-001.jpg`);
  });

  it("a file name with no date when they gave none, never the upload day", async () => {
    h = await startHarness();
    h.auth.respond = member();

    await send({ date: "" });

    const item = only();
    expect(item.file?.name).toBe(`dovetail-class-may-3_${item.fields.submissionid!.slice(0, 6)}-001.jpg`);
  });
});

describe("the read-back", () => {
  it("reads the Item back once and is done when everything held", async () => {
    h = await startHarness();
    h.auth.respond = member();

    const res = await send();

    expect(res.status).toBe(200);
    expect(calls("get_resource_field_data")).toHaveLength(1);
    expect(calls("update_field", "programevent")).toHaveLength(1);
    expect(h.logLines).toEqual([]);
  });

  it("writes again a required field that did not hold, and stops once it does", async () => {
    h = await startHarness();
    h.auth.respond = member();
    // ResourceSpace says yes but keeps nothing, once.
    let lost = 1;
    h.fakeRs.failWhen = (c) =>
      c.fn === "update_field" && c.params.get("field") === "programevent" && lost-- > 0 ? { json: true } : undefined;

    const res = await send();

    expect(res.status).toBe(200);
    expect(only().fields.programevent).toBe("Classes & Workshops");
    expect(calls("update_field", "programevent")).toHaveLength(2);
    expect(calls("get_resource_field_data")).toHaveLength(2);
    expect(h.logLines).toEqual([]);
  });

  it("also confirms the Submission ID, which the review link depends on", async () => {
    h = await startHarness();
    h.auth.respond = member();
    let lost = 2;
    h.fakeRs.failWhen = (c) =>
      c.fn === "update_field" && c.params.get("field") === "submissionid" && lost-- > 0 ? { json: true } : undefined;

    await send();

    expect(only().fields.submissionid).toMatch(/^[a-z0-9]{12}$/);
    expect(calls("update_field", "submissionid")).toHaveLength(3);
  });

  it("tries 3 more times at most, then logs it and counts the Item as received", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const c = client(h);
    const submission = await c.startSubmission();
    const id = await c.upload(jpeg(), { submission });
    // Deleted in ResourceSpace after the member chose it: RS drops the name without a word.
    h.fakeRs.options.programevent = h.fakeRs.options.programevent!.filter((o) => o.name !== "Classes & Workshops");

    const res = await c.finish(id);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "sent" });
    expect(calls("update_field", "programevent")).toHaveLength(4);
    expect(calls("get_resource_field_data")).toHaveLength(4);
    expect(h.logLines).toEqual([
      {
        message: "fields not confirmed on the Item after retrying; counted as received",
        fields: expect.objectContaining({ ref: only().ref, submissionId: submission, fields: ["programevent"], retries: 3 }),
      },
    ]);
    // Received: the staged file is gone and trying again answers sent without another Item.
    expect((await readdir(h.stagingDir)).filter((f) => f.startsWith(id))).toEqual([`${id}.item.json`]);
    expect((await c.finish(id)).status).toBe(200);
    expect(h.fakeRs.resources.size).toBe(1);
  });

  it("catches a choice deactivated between the form loading and the member pressing Send", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const c = client(h);
    // The page loads its choices...
    expect((await answer(await c.options())).options!.programevent).toContain("Holiday Gift Sale");
    // ...an administrator deactivates one; ResourceSpace still saves it if asked...
    option("programevent", "Holiday Gift Sale").active = false;
    // ...and the member, who chose it, presses Send while the list is still cached.
    const submission = await c.startSubmission(COOKIE, startBody({ details: { programevent: "Holiday Gift Sale" } }));

    const res = await c.finish(await c.upload(jpeg(), { submission }));

    expect(res.status).toBe(200);
    expect(only().fields.programevent).toBe("Holiday Gift Sale");
    expect(h.logLines).toHaveLength(1);
    expect(h.logLines[0]!.fields).toMatchObject({ submissionId: submission, fields: ["programevent"] });
  });

  it("checks every chosen subject, not just the first", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const c = client(h);
    const submission = await c.startSubmission(
      COOKIE,
      startBody({ details: { subjecttype: ["Finished Piece", "Tool or Equipment"] } }),
    );
    const id = await c.upload(jpeg(), { submission });
    h.fakeRs.options.subjecttype = h.fakeRs.options.subjecttype!.filter((o) => o.name !== "Tool or Equipment");

    await c.finish(id);

    expect(only().fields.subjecttype).toBe("Finished Piece");
    expect(h.logLines[0]!.fields).toMatchObject({ fields: ["subjecttype"] });
  });

  it("counts the Item as received when the read-back itself keeps failing, and logs why", async () => {
    h = await startHarness();
    h.auth.respond = member();
    h.fakeRs.failWhen = (c) => (c.fn === "get_resource_field_data" ? { status: 500, body: "down" } : undefined);

    const res = await send();

    expect(res.status).toBe(200);
    expect(calls("get_resource_field_data")).toHaveLength(4);
    expect(h.logLines).toHaveLength(1);
    expect(h.logLines[0]!.fields).toMatchObject({
      fields: ["title", "programevent", "subjecttype", "submissionid"],
      error: expect.stringContaining("get_resource_field_data"),
    });
  });
});
