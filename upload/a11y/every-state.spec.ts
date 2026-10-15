// axe over every screen and every state (#62, #31, #30), on the built page
// in a real browser, so colour contrast is measured as drawn.
import { expect, test, type Page } from "@playwright/test";
import { BOOTS, openPage, photo, video, type Answer } from "./fake-service.ts";
import { choose, describe as describeAll, expectNoViolations, sendAll, toChange } from "./journey.ts";

const NOT_SAVED: Answer = { status: 502, json: { error: "not_saved" } };
const WRONG_TYPE: Answer = { status: 422, json: { error: "wrong_type" } };
const BUSY: Answer = { status: 503, json: { error: "busy" } };

/** Item states are said in words: wait for this one's line to show. */
const line = (page: Page, text: string | RegExp) => page.getByRole("status").filter({ hasText: text }).first();

test.describe("pages the service chooses", () => {
  test("not a member (403)", async ({ page }) => {
    await openPage(page, BOOTS.notMember);
    await expect(page.getByRole("heading", { name: "This page is for current SDFWA members" })).toBeVisible();
    await expectNoViolations(page);
  });

  test("sharing paused", async ({ page }) => {
    await openPage(page, BOOTS.paused);
    await expect(page.getByText("Sharing is paused")).toBeVisible();
    await expectNoViolations(page);
  });

  test("unavailable", async ({ page }) => {
    await openPage(page, BOOTS.unavailable);
    await expect(page.getByRole("link", { name: "Try again" })).toBeVisible();
    await expectNoViolations(page);
  });

  test("the signed-in tab (/upload/signed-in)", async ({ page }) => {
    await openPage(page, BOOTS.signedIn, {}, "/upload/signed-in");
    await expect(page.getByText("You're signed in. You can close this tab.")).toBeVisible();
    await expectNoViolations(page);
  });
});

test.describe("Steps 1 to 3", () => {
  test("Step 1, nothing chosen", async ({ page }) => {
    await openPage(page, BOOTS.app);
    await expect(page.getByRole("heading", { level: 2, name: "Choose your photos and videos" })).toBeVisible();
    await expectNoViolations(page);
  });

  test("Step 1, chosen, with some that couldn't be added", async ({ page }) => {
    await openPage(page, BOOTS.app);
    const gif = { name: "party.gif", mimeType: "image/gif", buffer: Buffer.from("GIF89a" + "\0".repeat(40), "latin1") };
    await choose(page, [await photo(page, "IMG_0001.png"), video("IMG_0002.MOV"), gif]);
    await expect(page.getByText("We couldn't add some files")).toBeVisible();
    await expectNoViolations(page);
  });

  test("Step 1, the gallery's viewer", async ({ page }) => {
    await openPage(page, BOOTS.app);
    await choose(page, [await photo(page, "IMG_0001.png")]);
    await page.getByRole("button", { name: "See IMG_0001.png bigger" }).click();
    await expect(page.getByRole("dialog", { name: "IMG_0001.png, bigger" })).toBeVisible();
    await expectNoViolations(page);
  });

  test("Step 2, nothing answered yet", async ({ page }) => {
    await openPage(page, BOOTS.app);
    await choose(page, [await photo(page, "IMG_0001.png"), await photo(page, "IMG_0002.png", 200)]);
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByText(/^Still needed:/)).toBeVisible();
    await expectNoViolations(page);
  });

  test("Step 2, answered", async ({ page }) => {
    await openPage(page, BOOTS.app);
    await choose(page, [await photo(page, "IMG_0001.png")]);
    await describeAll(page);
    await expect(page.getByRole("button", { name: "Next" })).toBeEnabled();
    await expectNoViolations(page);
  });

  test("Step 2, the lists of choices couldn't load", async ({ page }) => {
    await openPage(page, BOOTS.app, { options: "fail" });
    await choose(page, [await photo(page, "IMG_0001.png")]);
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByText("We couldn't get the lists of choices just now.")).toBeVisible();
    await expectNoViolations(page);
  });

  test("Step 3, with one changed", async ({ page }) => {
    await openPage(page, BOOTS.app);
    await choose(page, [await photo(page, "IMG_0001.png"), await photo(page, "IMG_0002.png", 200)]);
    await describeAll(page);
    await toChange(page);
    await page.getByRole("button", { name: "Change details for IMG_0002.png" }).click();
    await page.getByRole("dialog").getByRole("textbox", { name: "What are these?" }).fill("Something else");
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("button", { name: "Change details for IMG_0002.png (Changed)" })).toBeVisible();
    await expectNoViolations(page);
  });

  test("Step 3, the change dialog", async ({ page }) => {
    await openPage(page, BOOTS.app);
    await choose(page, [await photo(page, "IMG_0001.png")]);
    await describeAll(page);
    await toChange(page);
    await page.getByRole("button", { name: "Change details for IMG_0001.png" }).click();
    await expect(page.getByRole("dialog", { name: "Change details for IMG_0001.png" })).toBeVisible();
    await expectNoViolations(page);
  });
});

test.describe("sending", () => {
  test("every Item state at once: Waiting, Sending, Finishing up, Sent, Connection trouble, Couldn't save, Can't be added", async ({ page }) => {
    await openPage(page, BOOTS.app, {
      // The first three settle at once; Connection trouble then pauses
      // before its next try, while Finishing up and Sending hold both
      // places, so it and the last one keep waiting.
      handOff: (name) =>
        ({ "sent.png": { status: 200, json: { status: "sent" } }, "save.png": NOT_SAVED, "refuse.png": WRONG_TYPE, "drop.png": "drop" } as Record<string, Answer>)[
          name
        ] ?? "hold",
      upload: (name) => (name === "sending.png" ? "hold" : "ok"),
    });
    await sendAll(page, [
      await photo(page, "sent.png", 120),
      await photo(page, "save.png", 0),
      await photo(page, "refuse.png", 280),
      await photo(page, "drop.png", 200),
      video("clip.mov"),
      await photo(page, "sending.png", 60),
      await photo(page, "waiting.png", 160),
    ]);
    for (const text of [
      "✓ Sent",
      "Couldn't save this one",
      /Can't be added: /,
      "Connection dropped. Trying again…",
      "Finishing up… (videos can take a few minutes)",
      "Sending…",
      "Waiting…",
    ]) {
      await expect(line(page, text)).toBeVisible();
    }
    await expect(page.getByRole("progressbar")).toHaveCount(2);
    await expectNoViolations(page);
  });

  test("busy: the page keeps trying, then the Item's own Try again; and Waiting for your connection", async ({ page }) => {
    await page.clock.install();
    await openPage(page, BOOTS.app, { handOff: (name) => (name === "busy.png" ? BUSY : "drop") });
    await sendAll(page, [await photo(page, "busy.png"), await photo(page, "stall.png", 200)]);
    await expect(page.getByText("We're busy right now. We'll keep trying for a few minutes.")).toBeVisible();
    await expectNoViolations(page);

    // Every automatic try, about 10 minutes of them.
    for (let i = 0; i < 30; i++) {
      if (await line(page, "Waiting for your connection").isVisible()) {
        if (await line(page, "We're busy right now. Please try again in a few minutes.").isVisible()) break;
      }
      await page.clock.runFor(61_000);
    }
    await expect(line(page, "Waiting for your connection")).toBeVisible();
    await expect(line(page, "We're busy right now. Please try again in a few minutes.")).toBeVisible();
    await expectNoViolations(page);
  });

  test("offline banner", async ({ page, context }) => {
    await openPage(page, BOOTS.app, { handOff: () => "hold" });
    await sendAll(page, [await photo(page, "IMG_0001.png")]);
    await context.setOffline(true);
    await expect(page.getByText("No internet connection.")).toBeVisible();
    await expectNoViolations(page);
  });

  test("signed out part way through", async ({ page }) => {
    await openPage(page, BOOTS.app, { handOff: () => ({ status: 401, json: { error: "signed_out" } }) });
    await sendAll(page, [await photo(page, "IMG_0001.png")]);
    await expect(page.getByRole("link", { name: "Sign in again" })).toBeVisible();
    await expectNoViolations(page);
  });

  test("membership lapsed part way through", async ({ page }) => {
    await openPage(page, BOOTS.app, { handOff: () => ({ status: 403, json: { error: "not_member" } }) });
    await sendAll(page, [await photo(page, "IMG_0001.png")]);
    await expect(page.getByRole("link", { name: "Renew my membership" })).toBeVisible();
    await expectNoViolations(page);
  });
});

test.describe("the end", () => {
  test("thank you, all sent", async ({ page }) => {
    await openPage(page, BOOTS.app);
    await sendAll(page, [await photo(page, "IMG_0001.png"), video("IMG_0002.MOV")]);
    await expect(page.getByRole("heading", { name: "Thank you! We have your 1 photo and 1 video." })).toBeVisible();
    await expectNoViolations(page);
  });

  test("Most of your photos are in", async ({ page }) => {
    await openPage(page, BOOTS.app, { handOff: (name) => (name === "IMG_0002.png" ? NOT_SAVED : { status: 200, json: { status: "sent" } }) });
    await sendAll(page, [await photo(page, "IMG_0001.png"), await photo(page, "IMG_0002.png", 200)]);
    await expect(page.getByRole("heading", { name: "Most of your photos are in." })).toBeVisible();
    await expectNoViolations(page);
  });

  test("thank you, after I'll do the rest later", async ({ page }) => {
    await openPage(page, BOOTS.app, { handOff: (name) => (name === "IMG_0002.png" ? WRONG_TYPE : { status: 200, json: { status: "sent" } }) });
    await sendAll(page, [await photo(page, "IMG_0001.png"), await photo(page, "IMG_0002.png", 200)]);
    await page.getByRole("button", { name: "I'll do the rest later" }).click();
    await expect(page.getByText("The ones that didn't go through weren't sent.")).toBeVisible();
    await expectNoViolations(page);
  });
});
