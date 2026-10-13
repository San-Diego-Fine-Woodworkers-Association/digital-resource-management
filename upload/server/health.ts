// Health: staging usage and whether ResourceSpace answers. This is what a
// future uptime monitor watches (issue #23), so it is 503 whenever the
// service could not take an upload.
//
// Whether ResourceSpace answers also decides whether new Items are taken at
// all (#23, #60): while it does not, nothing new is staged that could not be
// handed over. That check is remembered briefly, so a page full of uploads
// does not ask ResourceSpace about every one.
import http from "node:http";
import https from "node:https";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { Config } from "./config.ts";
import { statVolume, type VolumeStatsOf } from "./staging.ts";

export interface StagingHealth {
  ok: boolean;
  writable: boolean;
  usedBytes: number;
  totalBytes: number;
  usedPercent: number;
  capPercent: number;
}

export interface Health {
  status: "ok" | "degraded";
  paused: boolean;
  /** configured: the upload-service API key is set (without it no upload can be taken). */
  resourcespace: { reachable: boolean; configured: boolean };
  staging: StagingHealth;
}

export async function stagingHealth(dir: string, capPercent: number, stats: VolumeStatsOf = statVolume): Promise<StagingHealth> {
  try {
    const { totalBytes, freeBytes } = await stats(dir);
    const usedBytes = totalBytes - freeBytes;
    const usedPercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 100;
    let writable = true;
    try {
      await access(dir, constants.W_OK);
    } catch {
      writable = false;
    }
    return { ok: writable && usedPercent < capPercent, writable, usedBytes, totalBytes, usedPercent, capPercent };
  } catch {
    return { ok: false, writable: false, usedBytes: 0, totalBytes: 0, usedPercent: 0, capPercent };
  }
}

/**
 * Reachable means ResourceSpace answered at all without a server error. Its
 * front page may be a login page or a redirect; both count. The request goes
 * straight over the Docker network with the public Host header (issue #17).
 */
export function resourceSpaceReachable(config: Config): Promise<boolean> {
  return new Promise((resolve) => {
    const url = new URL("/", config.rsBaseUrl);
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(url, {
      method: "GET",
      headers: { host: config.rsHostHeader, "x-forwarded-proto": "https", accept: "text/html" },
      timeout: config.rsTimeoutMs,
    });
    req.on("response", (res) => {
      res.resume();
      resolve((res.statusCode ?? 500) < 500);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve(false));
    req.end();
  });
}

/** Remembered this long after ResourceSpace answered... */
const REACHABLE_FOR_MS = 15_000;
/** ...and this long after it did not, so it is soon asked again. */
const UNREACHABLE_FOR_MS = 5_000;

export interface Reachability {
  /**
   * Whether ResourceSpace answered recently, asking it again when that is
   * not known. Everyone asking at once shares one request; the health
   * endpoint too, since anyone may call it and it must not become a way to
   * keep ResourceSpace busy.
   */
  reachable(): Promise<boolean>;
}

export function createReachability(config: Config, now: () => number = Date.now): Reachability {
  let known: { reachable: boolean; at: number } | undefined;
  let asking: Promise<boolean> | undefined;
  return {
    reachable() {
      if (known && now() - known.at < (known.reachable ? REACHABLE_FOR_MS : UNREACHABLE_FOR_MS)) {
        return Promise.resolve(known.reachable);
      }
      asking ??= resourceSpaceReachable(config).then((reachable) => {
        known = { reachable, at: now() };
        asking = undefined;
        return reachable;
      });
      return asking;
    },
  };
}

export async function checkHealth(
  config: Config,
  configured: boolean,
  deps: { reachability?: Reachability; stats?: VolumeStatsOf } = {},
): Promise<Health> {
  const [reachable, staging] = await Promise.all([
    deps.reachability ? deps.reachability.reachable() : resourceSpaceReachable(config),
    stagingHealth(config.stagingDir, config.stagingCapPercent, deps.stats),
  ]);
  return {
    status: reachable && configured && staging.ok ? "ok" : "degraded",
    paused: config.uploadsPaused,
    resourcespace: { reachable, configured },
    staging,
  };
}
