// The member's way through the page, as a member does it: by the words on
// the screen, never by class names.
import { expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

type FileSpec = { name: string; mimeType: string; buffer: Buffer };

/** Step 1: choose these photos and videos. */
export async function choose(page: Page, files: FileSpec[]) {
  await page.locator('input[type="file"]').setInputFiles(files);
  await expect(page.getByText(/ chosen$/)).toBeVisible();
}

/** Step 1 to Step 2, and the required answers. */
export async function describe(page: Page) {
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Tell us about them" })).toBeVisible();
  await answer(page);
}

/** On Step 2: the required answers. */
export async function answer(page: Page) {
  await page.getByRole("textbox", { name: /What are these\?/ }).fill("Dovetail class, May 3");
  await page.getByRole("button", { name: /What was the occasion\?/ }).click();
  await page.getByRole("option", { name: "Classes & Workshops" }).click();
  // Tapped by their words, as a member does (the box itself is drawn over the hidden input).
  await page.getByText("Finished Piece", { exact: true }).click();
  await page.getByText(/^I took these/).click();
  await expect(page.getByRole("checkbox", { name: /I took these/ })).toBeChecked();
}

/** Step 2 to Step 3. */
export async function toChange(page: Page) {
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Change any single one (optional)" })).toBeVisible();
}

/** Step 3: Send them. Sending may already be over when this returns, if the service answered at once. */
export async function send(page: Page) {
  await page.getByRole("button", { name: "Send them" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Change any single one (optional)" })).toBeHidden();
}

/** From an empty page to sending these. */
export async function sendAll(page: Page, files: FileSpec[]) {
  await choose(page, files);
  await describe(page);
  await toChange(page);
  await send(page);
}

/**
 * WCAG 2.2 A and AA (#31's target), plus axe's best practices. Nothing is
 * excluded: a rule that fails is fixed, or is the design system's to fix
 * and listed in docs/accessibility.md.
 */
export async function expectNoViolations(page: Page) {
  // Let transitions (the dialog's fade, the progress bar) settle, so colours are measured as shown.
  await page.waitForTimeout(350);
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa", "best-practice"])
    .analyze();
  const found = results.violations.map((v) => ({
    rule: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((n) => `${n.target.join(" ")}: ${n.failureSummary?.split("\n").slice(1).join(" ").trim()}`),
  }));
  expect(found, JSON.stringify(found, null, 2)).toEqual([]);
}
