// The service's settings, read once at startup from the environment (set in
// Dokploy). A bad value stops the service from starting rather than running
// half-configured.
import path from "node:path";

export interface Config {
  port: number;
  /** Where members reach the site, e.g. https://media.sdfwa.org. Used for every absolute URL we hand out. */
  publicBaseUrl: string;
  /** The SDFWA auth service, e.g. https://auth.sdfwa.org. */
  authBaseUrl: string;
  /** ResourceSpace on the Docker network, e.g. http://resourcespace. */
  rsBaseUrl: string;
  /** Host header sent to ResourceSpace, so it answers as the public site. */
  rsHostHeader: string;
  /** Where a member whose membership has lapsed goes to renew. */
  renewUrl: string;
  /** The kill switch. */
  uploadsPaused: boolean;
  /** The staging volume's mount point inside the container. */
  stagingDir: string;
  /** Staging is "full" at this percentage of the volume. */
  stagingCapPercent: number;
  /** The built web app (index.html and assets). */
  webRoot: string;
  authTimeoutMs: number;
  rsTimeoutMs: number;
}

type Env = Record<string, string | undefined>;

const DEFAULT_WEB_ROOT = path.resolve(import.meta.dirname, "..", "dist", "web");

/** A base URL: validated, with any trailing slash removed so paths can be appended. */
function httpUrl(env: Env, key: string, fallback: string): string {
  return httpLink(env, key, fallback).replace(/\/+$/, "");
}

/** A page link: validated, otherwise kept exactly as given. */
function httpLink(env: Env, key: string, fallback: string): string {
  const raw = (env[key] ?? "").trim() || fallback;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${key} must be an http(s) URL, got ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${key} must be an http(s) URL, got ${JSON.stringify(raw)}`);
  }
  return url.toString();
}

function int(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = (env[key] ?? "").trim();
  if (raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${key} must be a whole number from ${min} to ${max}, got ${JSON.stringify(raw)}`);
  }
  return n;
}

/** Off only for an explicit "off" value: a typo leaves the kill switch on. */
function killSwitch(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return !["", "false", "0", "no", "off"].includes(v);
}

export function loadConfig(env: Env): Config {
  const publicBaseUrl = httpUrl(env, "PUBLIC_BASE_URL", "https://media.sdfwa.org");
  return {
    port: int(env, "PORT", 8080, 1, 65535),
    publicBaseUrl,
    authBaseUrl: httpUrl(env, "AUTH_BASE_URL", "https://auth.sdfwa.org"),
    rsBaseUrl: httpUrl(env, "RS_BASE_URL", "http://resourcespace"),
    rsHostHeader: (env.RS_HOST_HEADER ?? "").trim() || new URL(publicBaseUrl).host,
    renewUrl: httpLink(env, "RENEW_URL", "https://sdfwa.org/sdfwa-membership-levels/"),
    uploadsPaused: killSwitch(env.UPLOADS_PAUSED),
    stagingDir: (env.STAGING_DIR ?? "").trim() || "/staging",
    stagingCapPercent: int(env, "STAGING_CAP_PERCENT", 80, 0, 100),
    webRoot: (env.WEB_ROOT ?? "").trim() || DEFAULT_WEB_ROOT,
    authTimeoutMs: int(env, "AUTH_TIMEOUT_MS", 5000, 1, 60000),
    rsTimeoutMs: int(env, "RS_TIMEOUT_MS", 3000, 1, 60000),
  };
}
