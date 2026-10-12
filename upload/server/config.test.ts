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
    expect(c.renewUrl).toBe("https://sdfwa.org/sdfwa-membership-levels/");
    expect(c.stagingDir).toBe("/staging");
    expect(c.stagingCapPercent).toBe(80);
    expect(c.uploadsPaused).toBe(false);
    expect(c.rsUser).toBe("upload-service");
    expect(c.rsPhotoResourceType).toBe(1);
    expect(c.rsVideoResourceType).toBe(3);
  });

  it("has the decided limits (#18)", () => {
    const MB = 1024 * 1024;
    expect(loadConfig({}).limits).toEqual({
      photoMaxBytes: 50 * MB,
      videoMaxBytes: 1024 * MB,
      maxItems: 50,
      maxVideos: 10,
      maxTotalBytes: 4 * 1024 * MB,
    });
  });

  it("can lower a limit but never raise it above what the page tells members", () => {
    expect(loadConfig({ SUBMISSION_MAX_ITEMS: "3" }).limits.maxItems).toBe(3);
    expect(() => loadConfig({ SUBMISSION_MAX_ITEMS: "51" })).toThrow("SUBMISSION_MAX_ITEMS");
    expect(() => loadConfig({ VIDEO_MAX_BYTES: String(2 * 1024 * 1024 * 1024) })).toThrow("VIDEO_MAX_BYTES");
  });

  // A missing secret must not stop the service (or the compose deploy): it
  // starts, and refuses uploads until the key is set.
  it("starts without the ResourceSpace key, marked as not configured", () => {
    expect(loadConfig({}).rsApiKey).toBe("");
    expect(loadConfig({ RS_UPLOADER_API_KEY: "  " }).rsApiKey).toBe("");
    expect(loadConfig({ RS_UPLOADER_API_KEY: "abc" }).rsApiKey).toBe("abc");
  });

  it("can send the ResourceSpace leg to the public address instead (the documented fallback)", () => {
    const c = loadConfig({ RS_BASE_URL: "https://media.example.org", PUBLIC_BASE_URL: "https://media.example.org" });
    expect(c.rsBaseUrl).toBe("https://media.example.org");
    expect(c.rsHostHeader).toBe("media.example.org");
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
    ["RS_PHOTO_RESOURCE_TYPE", "photo"],
    ["PHOTO_MAX_BYTES", "-1"],
    ["VIDEO_MAX_BYTES", "1.5"],
    ["SUBMISSION_MAX_BYTES", "lots"],
    ["RS_VIDEO_RESOURCE_TYPE", "video"],
  ])("refuses a bad %s", (key, value) => {
    expect(() => loadConfig({ [key]: value })).toThrow(key);
  });
});
