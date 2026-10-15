// The rest of #31's accessibility target that a browser can check by itself
// (#62): focus on each step change, what is announced while sending,
// reduced motion, reflow at 320 px and at 200% text, status in words, touch
// targets and the tokens' contrast. docs/accessibility.md records the
// results, and what still needs a person with a phone and a screen reader.
import { expect, test, type Page } from "@playwright/test";
import { BOOTS, openPage, photo, video, type Answer } from "./fake-service.ts";
import { answer, choose, describe as describeAll, send, toChange } from "./journey.ts";

const SENT: Answer = { status: 200, json: { status: "sent" } };
const NOT_SAVED: Answer = { status: 502, json: { error: "not_saved" } };

/** The focused element's tag and text. */
const focused = (page: Page) =>
  page.evaluate(() => ({ tag: document.activeElement?.tagName, text: document.activeElement?.textContent?.trim() }));

test.describe("focus moves to the step heading on each step change", () => {
  test("forward through every step, back with the page's Back and the browser's, to the end", async ({ page }) => {
    await openPage(page, BOOTS.app);
    // Not on first load: the page starts at the top as any page does.
    expect((await focused(page)).tag).toBe("BODY");

    await choose(page, [await photo(page, "IMG_0001.png")]);
    await page.getByRole("button", { name: "Next" }).click();
    await expect.poll(() => focused(page)).toEqual({ tag: "H2", text: "Tell us about them" });

    await answer(page);
    await page.getByRole("button", { name: "Next" }).click();
    await expect.poll(() => focused(page)).toEqual({ tag: "H2", text: "Change any single one (optional)" });

    await page.getByRole("button", { name: "Back" }).click();
    await expect.poll(() => focused(page)).toEqual({ tag: "H2", text: "Tell us about them" });

    // The browser's Back (Forward is not followed, by design: stepHistory.ts).
    // (history.back() rather than page.goBack(), which waits for a page load that a step change never makes.)
    await page.evaluate(() => history.back());
    await expect.poll(() => focused(page)).toEqual({ tag: "H2", text: "Choose your photos and videos" });

    await page.getByRole("button", { name: "Next" }).click();
    await expect.poll(() => focused(page)).toEqual({ tag: "H2", text: "Tell us about them" });

    // Every answer is still there.
    await toChange(page);
    await page.getByRole("button", { name: "Send them" }).click();
    await expect.poll(() => focused(page)).toEqual({ tag: "H2", text: "Thank you! We have your 1 photo." });
  });

  test("Sending", async ({ page }) => {
    await openPage(page, BOOTS.app, { handOff: () => "hold" });
    await choose(page, [await photo(page, "IMG_0001.png")]);
    await describeAll(page);
    await toChange(page);
    await send(page);
    await expect.poll(() => focused(page)).toEqual({ tag: "H2", text: "Sending" });
  });

  test("Most of your photos are in", async ({ page }) => {
    await openPage(page, BOOTS.app, { handOff: (name) => (name === "IMG_0002.png" ? NOT_SAVED : SENT) });
    await choose(page, [await photo(page, "IMG_0001.png"), await photo(page, "IMG_0002.png", 200)]);
    await describeAll(page);
    await toChange(page);
    await page.getByRole("button", { name: "Send them" }).click();
    await expect.poll(() => focused(page)).toEqual({ tag: "H2", text: "Most of your photos are in." });
  });
});

test.describe("screen readers hear each Item's state, not every percent", () => {
  test("each Item's state is its own polite live region; the percent and the bar are outside every live region", async ({ page }) => {
    await openPage(page, BOOTS.app, {
      handOff: (name) => (name === "save.png" ? NOT_SAVED : name === "sent.png" ? SENT : "hold"),
      upload: (name) => (name === "sending.png" ? "hold" : "ok"),
    });
    await choose(page, [await photo(page, "sent.png"), await photo(page, "save.png", 0), video("clip.mov"), await photo(page, "sending.png", 200)]);
    await describeAll(page);
    await toChange(page);
    await send(page);
    for (const text of ["✓ Sent", "Couldn't save this one", "Finishing up… (videos can take a few minutes)", "Sending…"]) {
      await expect(page.getByRole("status").filter({ hasText: text })).toBeVisible();
    }

    const regions = await page.evaluate(() => {
      const live = [...document.querySelectorAll<HTMLElement>('[role="status"], [role="alert"], [aria-live]')].filter(
        (el) => el.getAttribute("aria-live") !== "off",
      );
      const inLive = (el: Element) => live.some((r) => r.contains(el));
      return {
        live: live.map((el) => ({ role: el.getAttribute("role"), text: el.textContent?.trim() })),
        barsInLive: [...document.querySelectorAll('[role="progressbar"]')].filter(inLive).length,
        percentInLive: live.filter((el) => /%/.test(el.textContent ?? "")).length,
        bars: [...document.querySelectorAll('[role="progressbar"]')].map((el) => ({
          name: el.getAttribute("aria-label"),
          now: el.getAttribute("aria-valuenow"),
          text: el.getAttribute("aria-valuetext"),
        })),
      };
    });
    expect(regions.live).toEqual([
      { role: "status", text: "✓ Sent" },
      { role: "status", text: "Couldn't save this one" },
      { role: "status", text: "Finishing up… (videos can take a few minutes)" },
      { role: "status", text: "Sending…" },
    ]);
    expect(regions.barsInLive).toBe(0);
    expect(regions.percentInLive).toBe(0);
    // Each bar is named by its file, so a screen reader that moves to it hears whose it is.
    expect(regions.bars).toEqual([
      { name: "clip.mov", now: null, text: null },
      { name: "sending.png", now: "0", text: "0%" },
    ]);
  });

  test("while sending, what changes in a live region is only ever a state's words", async ({ page }) => {
    await openPage(page, BOOTS.app);
    await choose(page, [await photo(page, "IMG_0001.png"), await photo(page, "IMG_0002.png", 200), await photo(page, "IMG_0003.png", 100)]);
    await describeAll(page);
    await toChange(page);
    // Record every text a live region shows, from Send to the thank-you.
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { seen: string[] }).seen = seen;
      new MutationObserver(() => {
        for (const el of document.querySelectorAll('[role="status"], [role="alert"], [aria-live]')) {
          const t = el.textContent?.trim() ?? "";
          if (t && seen.at(-1) !== t) seen.push(t);
        }
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await page.getByRole("button", { name: "Send them" }).click();
    await expect(page.getByRole("heading", { name: /^Thank you!/ })).toBeVisible();
    const seen = await page.evaluate(() => (window as unknown as { seen: string[] }).seen);
    expect(seen.length).toBeGreaterThan(0);
    for (const t of seen) expect(["Waiting…", "Sending…", "Finishing up…", "✓ Sent"]).toContain(t);
  });
});

test.describe("reduced motion is respected", () => {
  async function finishing(page: Page) {
    await openPage(page, BOOTS.app, { handOff: () => "hold" });
    await choose(page, [await photo(page, "IMG_0001.png")]);
    await describeAll(page);
    await toChange(page);
    await send(page);
    await expect(page.getByText("Finishing up…")).toBeVisible();
  }
  const animations = (page: Page) =>
    page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length);

  test("without the setting, Finishing up's bar moves (so the check below means something)", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await finishing(page);
    expect(await animations(page)).toBeGreaterThan(0);
  });

  test("with it, nothing moves: Finishing up's bar, the dialogs", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await finishing(page);
    expect(await animations(page)).toBe(0);
  });
});

/** The page is wider than the window: it would scroll sideways. */
const scrollsSideways = (page: Page) =>
  page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth <= w) return false;
    // What sticks out, so a failure says where.
    return [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === "visible")
      .map((el) => `${el.scrollWidth} px in ${el.clientWidth}: ${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 4).join(".")} "${el.textContent?.trim().slice(0, 30)}"`)
      .slice(-6); // the innermost
  });

/** Every screen worth checking for reflow, each reached from a fresh page. */
const SCREENS: { name: string; reach: (page: Page) => Promise<void> }[] = [
  { name: "not a member", reach: (page) => openPage(page, BOOTS.notMember).then(() => {}) },
  { name: "paused", reach: (page) => openPage(page, BOOTS.paused).then(() => {}) },
  { name: "unavailable", reach: (page) => openPage(page, BOOTS.unavailable).then(() => {}) },
  {
    name: "Step 1 with the gallery and a refusal",
    reach: async (page) => {
      await openPage(page, BOOTS.app);
      const gif = { name: "a-very-long-file-name-from-a-camera-IMG_20240503_101112.gif", mimeType: "image/gif", buffer: Buffer.from("GIF89a" + "\0".repeat(40), "latin1") };
      await choose(page, [await photo(page, "IMG_0001.png"), video("IMG_0002.MOV"), await photo(page, "IMG_0003.png", 200), gif]);
    },
  },
  {
    name: "the gallery's viewer",
    reach: async (page) => {
      await openPage(page, BOOTS.app);
      await choose(page, [await photo(page, "IMG_0001.png")]);
      await page.getByRole("button", { name: "See IMG_0001.png bigger" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
    },
  },
  {
    name: "Step 2",
    reach: async (page) => {
      await openPage(page, BOOTS.app);
      await choose(page, [await photo(page, "IMG_0001.png")]);
      await describeAll(page);
    },
  },
  {
    name: "Step 3's dialog",
    reach: async (page) => {
      await openPage(page, BOOTS.app);
      await choose(page, [await photo(page, "IMG_0001.png")]);
      await describeAll(page);
      await toChange(page);
      await page.getByRole("button", { name: "Change details for IMG_0001.png" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
    },
  },
  {
    name: "Sending, with every kind of line",
    reach: async (page) => {
      await openPage(page, BOOTS.app, {
        handOff: (name) => (name === "save.png" ? NOT_SAVED : name === "refuse.png" ? { status: 422, json: { error: "too_big" } } : "hold"),
      });
      await choose(page, [await photo(page, "save.png"), await photo(page, "refuse.png", 200), video("a-long-video-name-VID_20240503_101112.mov")]);
      await describeAll(page);
      await toChange(page);
      await send(page);
      await expect(page.getByText("Couldn't save this one")).toBeVisible();
    },
  },
  {
    name: "membership lapsed part way through",
    reach: async (page) => {
      await openPage(page, BOOTS.app, { handOff: () => ({ status: 403, json: { error: "not_member" } }) });
      await choose(page, [await photo(page, "IMG_0001.png")]);
      await describeAll(page);
      await toChange(page);
      await send(page);
      await expect(page.getByRole("link", { name: "Renew my membership" })).toBeVisible();
    },
  },
  {
    name: "Most of your photos are in",
    reach: async (page) => {
      await openPage(page, BOOTS.app, { handOff: (name) => (name === "IMG_0002.png" ? NOT_SAVED : SENT) });
      await choose(page, [await photo(page, "IMG_0001.png"), await photo(page, "IMG_0002.png", 200)]);
      await describeAll(page);
      await toChange(page);
      await page.getByRole("button", { name: "Send them" }).click();
      await expect(page.getByRole("heading", { name: "Most of your photos are in." })).toBeVisible();
    },
  },
];

test.describe("reflow: no sideways scrolling", () => {
  for (const screen of SCREENS) {
    test(`320 px wide: ${screen.name}`, async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 640 });
      await screen.reach(page);
      expect(await scrollsSideways(page)).toBe(false);
    });

    test(`200% text, on a 390 px phone: ${screen.name}`, async ({ page }) => {
      await screen.reach(page);
      // As a browser's own text size set to double: the page's root size is a percentage of it.
      await page.addStyleTag({ content: "html { font-size: 225% !important; }" });
      expect(await scrollsSideways(page)).toBe(false);
    });
  }
});

test.describe("touch targets are at least 48 px", () => {
  /** Every control a member can tap that is smaller than 48 × 48 px, other than a link in a sentence. */
  const small = (page: Page) =>
    page.evaluate(() => {
      const controls = document.querySelectorAll<HTMLElement>(
        'button, a[href], [role="button"], [role="option"], [role="checkbox"], input:not([type="file"]), textarea, label:has(input[type="checkbox"])',
      );
      const out: string[] = [];
      for (const el of controls) {
        // A checkbox's input is hidden; its label is what is tapped (checked above as a label).
        if (el instanceof HTMLInputElement && el.type === "checkbox") continue;
        const r = el.getBoundingClientRect();
        // Visually hidden (the dialogs' Dismiss for screen readers, which is not tapped).
        if (r.width <= 1 || r.height <= 1) continue;
        // WCAG's inline exception: a link inside a line of text (Sign out, in the header).
        if (el.tagName === "A" && getComputedStyle(el).display === "inline") continue;
        if (r.width < 47.5 || r.height < 47.5) {
          out.push(`${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40)}" ${Math.round(r.width)}×${Math.round(r.height)}`);
        }
      }
      return out;
    });

  for (const screen of SCREENS) {
    test(screen.name, async ({ page }) => {
      await screen.reach(page);
      expect(await small(page)).toEqual([]);
    });
  }

  test("an open list of choices", async ({ page }) => {
    await openPage(page, BOOTS.app);
    await choose(page, [await photo(page, "IMG_0001.png")]);
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("button", { name: /What was the occasion\?/ }).click();
    await expect(page.getByRole("listbox")).toBeVisible();
    expect(await small(page)).toEqual([]);
  });
});

test.describe("status never relies on colour alone", () => {
  test("every Item state reads differently in words, and Changed is a word on the tile and in its name", async ({ page }) => {
    await openPage(page, BOOTS.app, {
      handOff: (name) => ({ "sent.png": SENT, "save.png": NOT_SAVED, "refuse.png": { status: 422, json: { error: "wrong_type" } } })[name] ?? "hold",
    });
    await choose(page, [await photo(page, "sent.png"), await photo(page, "save.png", 0), await photo(page, "refuse.png", 200), await photo(page, "wait.png", 90)]);
    await describeAll(page);
    await toChange(page);
    await page.getByRole("button", { name: "Change details for save.png" }).click();
    await page.getByRole("dialog").getByRole("textbox", { name: "What are these?" }).fill("Something else");
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("button", { name: "Change details for save.png (Changed)" })).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: "Changed" })).toHaveCount(1);
    await send(page);
    await expect(page.getByText("Couldn't save this one")).toBeVisible();
    // With every colour taken away, each line still says what it is.
    await page.addStyleTag({ content: "* { color: black !important; background: white !important; border-color: black !important; }" });
    const lines = await page.getByRole("status").allTextContents();
    expect(lines).toEqual(["✓ Sent", "Couldn't save this one", expect.stringMatching(/^Can't be added: /), "Finishing up…"]);
    expect(new Set(lines).size).toBe(lines.length);
  });
});

test.describe("contrast, measured from the tokens as drawn", () => {
  /**
   * Each pair is drawn on a canvas in the page, so the browser does the
   * colour conversion and the transparency: a tint is drawn over the page
   * colour first, as the page shows it.
   */
  const PAIRS: { name: string; fg: string; bg: string[]; needs: number; known?: string }[] = [
    { name: "Body text on page", fg: "--foreground", bg: ["--background"], needs: 4.5 },
    { name: "Muted text on page", fg: "--muted-foreground", bg: ["--background"], needs: 4.5 },
    { name: "Muted text on card", fg: "--muted-foreground", bg: ["--card"], needs: 4.5 },
    { name: "Primary button text", fg: "--primary-foreground", bg: ["--primary"], needs: 4.5 },
    { name: "Secondary button text", fg: "--secondary-foreground", bg: ["--secondary"], needs: 4.5 },
    { name: "Red text on page", fg: "--destructive", bg: ["--background"], needs: 4.5 },
    { name: "White text on the red button", fg: "--destructive-foreground", bg: ["--destructive"], needs: 4.5 },
    { name: "Text-field border against the page", fg: "--input", bg: ["--background"], needs: 3 },
    { name: "Focus ring against the page", fg: "--ring", bg: ["--background"], needs: 3 },
    { name: "Primary (step bar, progress) against the page", fg: "--primary", bg: ["--background"], needs: 3 },
    { name: "Body text on the thank-you's tint", fg: "--foreground", bg: ["--background", "success 15%"], needs: 4.5 },
    { name: "Body text on the warning tint", fg: "--foreground", bg: ["--background", "warning 15%"], needs: 4.5 },
    // Below: what the design system's Notification and the Done card draw; not used for text on this page any more.
    { name: "Card and divider border against the page", fg: "--border", bg: ["--background"], needs: 3, known: "left as is on #31" },
    { name: "Notification body (muted) on the info tint", fg: "--muted-foreground", bg: ["--background", "info 15%"], needs: 4.5, known: "design system; the page uses full-strength text instead" },
    { name: "Notification body (muted) on the warning tint", fg: "--muted-foreground", bg: ["--background", "warning 15%"], needs: 4.5, known: "design system; the page uses full-strength text instead" },
    { name: "Red text on the warning tint", fg: "--destructive", bg: ["--background", "warning 15%"], needs: 4.5, known: "no longer drawn: Most of your photos are in uses full-strength text" },
  ];

  test("every pair, against what it needs", async ({ page }) => {
    await openPage(page, BOOTS.paused);
    const measured = await page.evaluate((pairs) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const g = canvas.getContext("2d", { willReadFrequently: true })!;
      const root = getComputedStyle(document.documentElement);
      const colour = (token: string) => root.getPropertyValue(token).trim();
      const rgb = (layers: string[]) => {
        g.globalAlpha = 1;
        g.fillStyle = "#fff";
        g.fillRect(0, 0, 1, 1);
        for (const layer of layers) {
          const [name, pct] = layer.split(" ");
          g.globalAlpha = pct ? parseFloat(pct) / 100 : 1;
          g.fillStyle = colour(name!.startsWith("--") ? name! : `--${name}`);
          g.fillRect(0, 0, 1, 1);
        }
        const [r, gr, b] = g.getImageData(0, 0, 1, 1).data;
        return [r!, gr!, b!];
      };
      const lum = ([r, gr, b]: number[]) => {
        const c = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        return 0.2126 * c(r!) + 0.7152 * c(gr!) + 0.0722 * c(b!);
      };
      return pairs.map((p) => {
        const a = lum(rgb(p.bg.concat(p.fg))), b = lum(rgb(p.bg));
        return { ...p, ratio: Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100 };
      });
    }, PAIRS);
    // The table in docs/accessibility.md comes from this.
    console.log(measured.map((m) => `${m.name}: ${m.ratio}:1 (needs ${m.needs})${m.known ? ` [${m.known}]` : ""}`).join("\n"));
    for (const m of measured) if (!m.known) expect(m.ratio, m.name).toBeGreaterThanOrEqual(m.needs);
  });
});

test.describe("keyboard only", () => {
  /** The focused control's name, as a screen reader would say it, and whether its focus ring shows. */
  const focusNow = (page: Page) =>
    page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return { name: "", ring: false };
      const byIds = el
        .getAttribute("aria-labelledby")
        ?.split(" ")
        .map((id) => document.getElementById(id)?.textContent?.trim())
        .join(" ");
      const name = (el.getAttribute("aria-label") ?? byIds ?? (el as HTMLInputElement).labels?.[0]?.textContent ?? el.textContent ?? "").trim();
      // The ring is drawn on the control, or (a checkbox) on its box inside the label React Aria marks.
      const marked = el.closest<HTMLElement>("[data-focus-visible]") ?? el;
      const drawn = [marked, ...marked.querySelectorAll<HTMLElement>("*")].some((e) => {
        const s = getComputedStyle(e);
        return (s.boxShadow !== "none" && s.boxShadow !== "") || (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0);
      });
      return { name, ring: drawn };
    });

  /** Presses Tab until the control named `name` has the focus, and checks it shows. */
  async function tabTo(page: Page, name: string | RegExp) {
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      const now = await focusNow(page);
      if (typeof name === "string" ? now.name === name : name.test(now.name)) {
        expect(now.ring, `focus ring on ${now.name}`).toBe(true);
        return;
      }
    }
    throw new Error(`Tab never reached ${name}`);
  }

  test("the whole way, from choosing to the thank-you, with the gallery and Step 3's dialog", async ({ page }) => {
    await openPage(page, BOOTS.app);
    await tabTo(page, "Choose photos and videos");
    const chooser = page.waitForEvent("filechooser");
    await page.keyboard.press("Enter");
    await (await chooser).setFiles([await photo(page, "IMG_0001.png"), await photo(page, "IMG_0002.png", 200)]);

    // The viewer opens, closes with Escape, and gives the focus back to its tile.
    await tabTo(page, "See IMG_0001.png bigger");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect.poll(async () => (await focusNow(page)).name).toBe("See IMG_0001.png bigger");

    await tabTo(page, "Next");
    await page.keyboard.press("Enter");
    await expect.poll(() => focused(page)).toEqual({ tag: "H2", text: "Tell us about them" });

    await tabTo(page, /^What are these\?/);
    await page.keyboard.type("Dovetail class, May 3");
    await tabTo(page, /What was the occasion\?/);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("listbox")).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("listbox")).toBeHidden();
    await tabTo(page, "Finished Piece");
    await page.keyboard.press("Space");
    await tabTo(page, /^I took these/);
    await page.keyboard.press("Space");
    await tabTo(page, "Next");
    await page.keyboard.press("Enter");
    await expect.poll(() => focused(page)).toEqual({ tag: "H2", text: "Change any single one (optional)" });

    // Step 3's dialog: changed by keyboard, closed with Escape, and the tile says Changed.
    await tabTo(page, "Change details for IMG_0002.png");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toBeVisible();
    await tabTo(page, /^What are these\?/);
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("Something else");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect.poll(async () => (await focusNow(page)).name).toBe("Change details for IMG_0002.png (Changed)");

    await tabTo(page, "Send them");
    await page.keyboard.press("Enter");
    await expect.poll(() => focused(page)).toEqual({ tag: "H2", text: "Thank you! We have your 2 photos." });
    await tabTo(page, "Share more photos or videos");
  });

  test("Remove and Try again while sending", async ({ page }) => {
    let failSave = true;
    await openPage(page, BOOTS.app, {
      handOff: (name) => (name === "save.png" && failSave ? NOT_SAVED : name === "refuse.png" ? { status: 422, json: { error: "wrong_type" } } : SENT),
    });
    await choose(page, [await photo(page, "save.png"), await photo(page, "refuse.png", 200)]);
    await describeAll(page);
    await toChange(page);
    await send(page);
    await expect(page.getByText("Couldn't save this one")).toBeVisible();
    await tabTo(page, "Remove");
    await page.keyboard.press("Enter");
    await expect(page.getByText(/^Can't be added/)).toBeHidden();
    failSave = false;
    await tabTo(page, "Try again");
    await page.keyboard.press("Enter");
    await expect.poll(() => focused(page)).toEqual({ tag: "H2", text: "Thank you! We have your 1 photo." });
  });
});
