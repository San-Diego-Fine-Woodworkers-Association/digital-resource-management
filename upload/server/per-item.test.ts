// Seam 1: each Item's own answers from Step 3 (#57), through the service's
// HTTP boundary. They travel with the Step 2 answers when the Submission is
// started, by the page's name for each Item, and are checked there exactly as
// the Step 2 answers are; each hand-off repeats its Item's name. What reaches
// ResourceSpace, on which Item, and what a retry or the read-back does.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ANSWERS, client, jpeg, member, startBody } from "./testing/client.ts";
import { FAKE_OPTIONS } from "./testing/fake-rs.ts";
import { COOKIE, startHarness, type Harness } from "./testing/harness.ts";

let h: Harness;
afterEach(async () => h?.close());

interface Answer {
  error?: string;
  problems?: { item?: string; field: string; problem: string }[];
  options?: Record<string, string[]>;
  submissionId?: string;
}
const answer = async (res: Response) => (await res.json()) as Answer;

const calls = (fn: string, field?: string) =>
  h.fakeRs.calls.filter((c) => c.fn === fn && (field === undefined || c.params.get("field") === field));

/** The Item ResourceSpace holds under this Item number of the Submission. */
const itemNumbered = (n: number) => {
  const found = [...h.fakeRs.resources.values()].filter((r) => r.file?.name.endsWith(`-${String(n).padStart(3, "0")}.jpg`));
  expect(found).toHaveLength(1);
  return found[0]!;
};

/** What the page sends to start a Submission with Items changed in Step 3. */
const withItems = (items: unknown, details: Record<string, unknown> = {}, expectedItems = 3) => ({
  ...startBody({ expectedItems, details }),
  items,
});

/** Starts a Submission, then sends one photo per page name, in order, each handed over with its name. */
async function sendAll(body: unknown, names: string[]) {
  const c = client(h);
  const submission = await c.startSubmission(COOKIE, body);
  for (const item of names) {
    const res = await c.finish(await c.upload(jpeg(), { submission }), { item });
    expect(res.status).toBe(200);
  }
  return submission;
}

describe("an Item changed in Step 3", () => {
  it("reaches ResourceSpace with its own answers, on that Item only, and the rest keep Step 2's", async () => {
    h = await startHarness();
    h.auth.respond = member();

    const submission = await sendAll(
      withItems({ "2": { subjecttype: ["Tool or Equipment", "Work in Progress"], title: "My jack plane" } }, { location: "Shop" }),
      ["1", "2", "3"],
    );

    expect(itemNumbered(2).fields).toMatchObject({
      title: "My jack plane",
      subjecttype: "Tool or Equipment, Work in Progress",
      // What it did not change is still Step 2's.
      programevent: ANSWERS.programevent,
      location: "Shop",
      submissionid: submission,
    });
    for (const n of [1, 3]) {
      expect(itemNumbered(n).fields).toMatchObject({
        title: ANSWERS.title,
        subjecttype: "Instruction / Class in Session",
        location: "Shop",
        submissionid: submission,
      });
    }
  });

  it("is matched by the page's name for it, whatever order the files arrive in", async () => {
    h = await startHarness();
    h.auth.respond = member();

    await sendAll(withItems({ "7": { caption: "The odd one out" } }), ["9", "7", "8"]);

    expect(itemNumbered(2).fields.caption).toBe("The odd one out");
    expect(itemNumbered(1).fields).not.toHaveProperty("caption");
    expect(itemNumbered(3).fields).not.toHaveProperty("caption");
  });

  it("keeps the Step 2 answer for every box it left empty: an Item cannot blank one", async () => {
    h = await startHarness();
    h.auth.respond = member();

    const submission = await sendAll(
      withItems(
        { "1": { title: "  ", location: "", caption: "", subjecttype: [], date: "", eventname: "Hand tools" } },
        { location: "Shop", caption: "From the class", date: "2026-05-03" },
        1,
      ),
      ["1"],
    );

    expect(itemNumbered(1).fields).toMatchObject({
      title: ANSWERS.title,
      subjecttype: "Instruction / Class in Session",
      location: "Shop",
      caption: "From the class",
      date: "2026-05-03",
      eventname: "Hand tools",
    });
    const record = JSON.parse(await readFile(path.join(h.stagingDir, `${submission}.submission.json`), "utf8"));
    expect(record.items).toEqual({ "1": { ...record.details, eventname: "Hand tools" } });
  });

  it("is not kept as its own when it changes nothing", async () => {
    h = await startHarness();
    h.auth.respond = member();

    const submission = await sendAll(withItems({ "1": { title: ANSWERS.title, location: "" } }, {}, 1), ["1"]);

    const record = JSON.parse(await readFile(path.join(h.stagingDir, `${submission}.submission.json`), "utf8"));
    expect(record).not.toHaveProperty("items");
  });

  it("is named with its own Date when it has one, and its own Title", async () => {
    h = await startHarness();
    h.auth.respond = member();

    const submission = await sendAll(
      withItems({ "2": { date: "2026-05-04", title: "Day two" }, "3": { caption: "Same name" } }),
      ["1", "2", "3"],
    );

    const code = submission.slice(0, 6);
    expect(itemNumbered(1).file?.name).toBe(`dovetail-class-may-3_${code}-001.jpg`);
    expect(itemNumbered(2).file?.name).toBe(`2026-05-04_day-two_${code}-002.jpg`);
    expect(itemNumbered(2).fields.date).toBe("2026-05-04");
    expect(itemNumbered(3).file?.name).toBe(`dovetail-class-may-3_${code}-003.jpg`);
  });

  it("gets the Step 2 answers when the hand-off names an Item that was not changed, or none", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const c = client(h);
    const submission = await c.startSubmission(COOKIE, withItems({ "1": { title: "Changed" } }, {}, 3));

    await c.finish(await c.upload(jpeg(), { submission }), { item: "2" });
    await c.finish(await c.upload(jpeg(), { submission }));
    await c.finish(await c.upload(jpeg(), { submission }), { item: "constructor" });

    for (const n of [1, 2, 3]) expect(itemNumbered(n).fields.title).toBe(ANSWERS.title);
  });

  it("takes many Items' answers at once, well past the size of one Submission's Step 2 answers", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const items = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [String(i + 1), { caption: `Item ${i + 1}: ${"x".repeat(1900)}` }]),
    );

    const res = await client(h).begin(withItems(items, {}, 50));

    expect(res.status).toBe(201);
  });
});

describe("checking each Item's own answers, as Step 2's are checked", () => {
  it.each([
    ["an occasion", { programevent: "Birthday party" }, "programevent", "not_offered"],
    ["a subject", { subjecttype: ["Finished Piece", "Cats"] }, "subjecttype", "not_offered"],
    ["a place", { location: "The moon" }, "location", "not_offered"],
    ["a date that is not a date", { date: "May 3" }, "date", "invalid"],
    ["a date that does not exist", { date: "2026-02-30" }, "date", "invalid"],
    ["a Title over 200 characters", { title: "x".repeat(201) }, "title", "too_long"],
    ["a class or event name over 200 characters", { eventname: "x".repeat(201) }, "eventname", "too_long"],
    ["a Caption over 2000 characters", { caption: "x".repeat(2001) }, "caption", "too_long"],
    ["subjects that are not names", { subjecttype: ["Finished Piece", 7] }, "subjecttype", "invalid"],
  ])("refuses %s, naming the Item, before anything is sent", async (_n, changes, field, problem) => {
    h = await startHarness();
    h.auth.respond = member();

    const res = await client(h).begin(withItems({ "1": {}, "2": changes }));

    expect(res.status).toBe(422);
    const body = await answer(res);
    expect(body.error).toBe("invalid_details");
    expect(body.problems).toEqual([{ item: "2", field, problem }]);
    expect(body.options).toEqual(FAKE_OPTIONS);
    expect(h.fakeRs.resources.size).toBe(0);
  });

  it("refuses a choice ResourceSpace has deactivated", async () => {
    h = await startHarness();
    h.auth.respond = member();
    h.fakeRs.options.subjecttype!.find((o) => o.name === "Tool or Equipment")!.active = false;

    const res = await client(h).begin(withItems({ "3": { subjecttype: ["Tool or Equipment"] } }));

    expect(res.status).toBe(422);
    const body = await answer(res);
    expect(body.problems).toEqual([{ item: "3", field: "subjecttype", problem: "not_offered" }]);
    expect(body.options!.subjecttype).not.toContain("Tool or Equipment");
  });

  it("takes a choice added since the choices were cached", async () => {
    h = await startHarness();
    h.auth.respond = member();
    await client(h).options();
    h.fakeRs.options.location!.push({ name: "Del Mar Fair", active: true });

    const res = await client(h).begin(withItems({ "1": { location: "Del Mar Fair" } }));

    expect(res.status).toBe(201);
  });

  it("reports a problem with Step 2's answers once, not again for every Item", async () => {
    h = await startHarness();
    h.auth.respond = member();

    const res = await client(h).begin(withItems({ "1": { caption: "Fine" } }, { title: "" }));

    expect((await answer(res)).problems).toEqual([{ field: "title", problem: "required" }]);
  });

  it.each([
    ["not a set of Items", ["a"]],
    ["an Item name that is not one", { "../1": { title: "x" } }],
    ["more Items than the Submission said it would send", { "1": {}, "2": {}, "3": {}, "4": {} }],
  ])("refuses %s", async (_n, items) => {
    h = await startHarness();
    h.auth.respond = member();

    expect((await client(h).begin(withItems(items))).status).toBe(400);
  });
});

describe("the rights confirmation", () => {
  it("is the Submission's on every Item: an Item's answers cannot change it, nor the Submitter fields", async () => {
    h = await startHarness();
    h.auth.respond = member();

    const submission = await sendAll(
      withItems(
        {
          "1": {
            rightsConfirmed: false,
            rights: "I did not take these",
            submitterrights: "Nothing confirmed",
            submissionid: "someoneelse1",
            submitteremail: "mallory@example.org",
            caption: "Mine",
          },
        },
        {},
        1,
      ),
      ["1"],
    );

    const record = JSON.parse(await readFile(path.join(h.stagingDir, `${submission}.submission.json`), "utf8"));
    expect(Object.keys(record.items["1"]).sort()).toEqual(
      ["caption", "date", "eventname", "location", "programevent", "subjecttype", "title"],
    );
    expect(itemNumbered(1).fields).toMatchObject({
      caption: "Mine",
      submitterrights: record.rights,
      submissionid: submission,
      submitteremail: "pat@example.org",
    });
    expect(calls("update_field", "submitterrights")).toHaveLength(1);
  });

  it("cannot be changed or answered for one Item on its hand-off either", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const c = client(h);
    const submission = await c.startSubmission(COOKIE, withItems({}, {}, 1));

    const res = await c.finish(await c.upload(jpeg(), { submission }), {
      item: "1",
      rightsConfirmed: false,
      rights: "Nothing confirmed",
      details: { title: "Sneaked in", subjecttype: ["Cats"] },
    });

    expect(res.status).toBe(200);
    const record = JSON.parse(await readFile(path.join(h.stagingDir, `${submission}.submission.json`), "utf8"));
    expect(itemNumbered(1).fields).toMatchObject({ title: ANSWERS.title, submitterrights: record.rights });
  });
});

describe("a retried hand-off", () => {
  it("never makes a second Item, and writes the answers the Item first got, whatever it names", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const c = client(h);
    const submission = await c.startSubmission(
      COOKIE,
      withItems({ "1": { subjecttype: ["Finished Piece"], date: "2026-05-04" }, "2": { title: "Other" } }, {}, 2),
    );
    const id = await c.upload(jpeg(), { submission });
    // ResourceSpace stops answering after the Item and its file exist.
    h.fakeRs.failWhen = (call) => (call.fn === "update_field" ? { status: 500, body: "down" } : undefined);
    expect((await c.finish(id, { item: "1" })).status).toBe(502);
    h.fakeRs.failWhen = () => undefined;

    // Asked again, naming another Item (or none).
    expect((await c.finish(id, { item: "2" })).status).toBe(200);
    expect((await c.finish(id)).status).toBe(200);

    expect(h.fakeRs.resources.size).toBe(1);
    expect(calls("create_resource")).toHaveLength(1);
    const item = itemNumbered(1);
    expect(item.fields).toMatchObject({ title: ANSWERS.title, subjecttype: "Finished Piece", date: "2026-05-04" });
    expect(item.file?.name).toBe(`2026-05-04_dovetail-class-may-3_${submission.slice(0, 6)}-001.jpg`);
  });
});

describe("the read-back of an Item's own answers", () => {
  it("confirms them and writes again one that did not hold, with the Item's value, not Step 2's", async () => {
    h = await startHarness();
    h.auth.respond = member();
    let lost = 1;
    h.fakeRs.failWhen = (call) =>
      call.fn === "update_field" && call.params.get("field") === "subjecttype" && lost-- > 0 ? { json: true } : undefined;

    await sendAll(withItems({ "1": { subjecttype: ["Tool or Equipment", "Finished Piece"] } }, {}, 1), ["1"]);

    const writes = calls("update_field", "subjecttype").map((call) => call.params.get("value"));
    expect(writes).toEqual(["Tool or Equipment,Finished Piece", "Tool or Equipment,Finished Piece"]);
    expect(itemNumbered(1).fields.subjecttype).toBe("Tool or Equipment, Finished Piece");
    expect(h.logLines).toEqual([]);
  });

  it("catches an Item's own choice deactivated after the member pressed Send, and logs it", async () => {
    h = await startHarness();
    h.auth.respond = member();
    const c = client(h);
    const submission = await c.startSubmission(COOKIE, withItems({ "1": { location: "Shop Tour" } }, {}, 1));
    const id = await c.upload(jpeg(), { submission });
    h.fakeRs.options.location!.find((o) => o.name === "Shop Tour")!.active = false;

    expect((await c.finish(id, { item: "1" })).status).toBe(200);

    expect(calls("update_field", "location")).toHaveLength(4);
    expect(h.logLines).toHaveLength(1);
    expect(h.logLines[0]!.fields).toMatchObject({ submissionId: submission, fields: ["location"] });
  });
});
