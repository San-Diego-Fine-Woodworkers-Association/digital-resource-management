// The accessibility checks (#62): the built page in a real Chromium, with
// the service faked (a11y/fake-service.ts). `npm run test:a11y` builds the
// page first. See docs/accessibility.md.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "a11y",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    // A phone's width, the page's main audience (#31); tests that need another size set their own.
    viewport: { width: 390, height: 844 },
    // Where the expected Chromium build isn't installed, point at another one.
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
  },
});
