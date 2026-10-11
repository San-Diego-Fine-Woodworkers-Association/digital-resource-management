import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

describe("loadConfig", () => {
  it("has production defaults", () => {
    const c = loadConfig({});
    expect(c.port).toBe(8080);
    expect(c.publicBaseUrl).toBe("https://media.sdfwa.org");
    expect(c.authBaseUrl).toBe("https://auth.sdfwa.org");
    expect(c.rsBaseUrl).toBe("http://resourcespace");
    expect(c.rsHostHeader).toBe("media.sdfwa.org");
    expect(c.renewUrl).toBe("https://www.sdfwa.org/membership");
    expect(c.stagingDir).toBe("/staging");
    expect(c.stagingCapPercent).toBe(80);
    expect(c.uploadsPaused).toBe(false);
  });

  it("takes the ResourceSpace Host header from the public address", () => {
    expect(loadConfig({ PUBLIC_BASE_URL: "https://media.example.org/" }).rsHostHeader).toBe("media.example.org");
    expect(loadConfig({ PUBLIC_BASE_URL: "https://media.example.org/" }).publicBaseUrl).toBe("https://media.example.org");
  });

  it.each(["", "false", "0", "no", "off", "FALSE", " false "])("leaves uploads on for UPLOADS_PAUSED=%j", (v) => {
    expect(loadConfig({ UPLOADS_PAUSED: v }).uploadsPaused).toBe(false);
  });

  // A kill switch should fail towards "paused": a typo must not leave it off.
  it.each(["true", "1", "yes", "on", "TRUE", "ture", "paused"])("pauses uploads for UPLOADS_PAUSED=%j", (v) => {
    expect(loadConfig({ UPLOADS_PAUSED: v }).uploadsPaused).toBe(true);
  });

  it.each([
    ["PUBLIC_BASE_URL", "not a url"],
    ["AUTH_BASE_URL", "ftp://auth"],
    ["STAGING_CAP_PERCENT", "120"],
    ["PORT", "abc"],
  ])("refuses a bad %s", (key, value) => {
    expect(() => loadConfig({ [key]: value })).toThrow(key);
  });
});
