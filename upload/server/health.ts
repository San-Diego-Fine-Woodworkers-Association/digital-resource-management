// Health: staging usage and whether ResourceSpace answers. This is what a
// future uptime monitor watches (issue #23), so it is 503 whenever the
// service could not take an upload.
import http from "node:http";
import https from "node:https";
import { constants } from "node:fs";
import { access, statfs } from "node:fs/promises";
import type { Config } from "./config.ts";

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
  resourcespace: { reachable: boolean };
  staging: StagingHealth;
}

export async function stagingHealth(dir: string, capPercent: number): Promise<StagingHealth> {
  try {
    const fs = await statfs(dir);
    const totalBytes = fs.blocks * fs.bsize;
    const usedBytes = (fs.blocks - fs.bfree) * fs.bsize;
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

export async function checkHealth(config: Config): Promise<Health> {
  const [reachable, staging] = await Promise.all([
    resourceSpaceReachable(config),
    stagingHealth(config.stagingDir, config.stagingCapPercent),
  ]);
  return {
    status: reachable && staging.ok ? "ok" : "degraded",
    paused: config.uploadsPaused,
    resourcespace: { reachable },
    staging,
  };
}
