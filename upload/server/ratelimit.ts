// A modest request rate limit per member and per address (#23, #60), so one
// browser, script or address cannot keep the service, or the auth service
// it asks about every request, busy for everyone else.
//
// A token bucket each: a burst is fine, a steady flood is not. Held in
// memory; buckets that have filled up again are dropped, so a stream of new
// addresses costs nothing once it stops.
//
// Which address. The service is only reached through Traefik (it publishes no
// port), and Traefik on this host trusts no forwarded headers
// (forwardedHeaders has no trustedIPs, the default): it drops any
// X-Forwarded-For a client sends and sets its own, the address it saw. So the
// last X-Forwarded-For entry, the one Traefik adds, is the client, and a
// client cannot choose it. Were Traefik ever told to trust a proxy in front
// (a CDN), the last entry would become that proxy's address; this would then
// need to take the entry before it. Without the header (tests, or someone on
// the Docker network) it is the TCP peer.
import type http from "node:http";
import { isIP } from "node:net";
import type { RateLimit } from "./config.ts";

export interface RateLimiter {
  /**
   * Takes one request from `key`'s allowance: undefined if it may go ahead,
   * or how long to wait. `first` is set on the first refusal after a request
   * went ahead, so a flood is logged once, not once per request.
   */
  take(key: string): { retryAfterS: number; first: boolean } | undefined;
}

/** Past this many buckets, full ones are dropped. */
const PRUNE_AT = 10_000;

interface Bucket {
  tokens: number;
  at: number;
  /** Refusing since the last request that went ahead. */
  refusing: boolean;
}

export function createRateLimiter(limit: RateLimit, now: () => number = Date.now): RateLimiter {
  const perMs = limit.perMinute / 60_000;
  const buckets = new Map<string, Bucket>();

  const level = (b: Bucket, t: number) => Math.min(limit.burst, b.tokens + (t - b.at) * perMs);

  function prune(t: number) {
    for (const [key, b] of buckets) if (level(b, t) >= limit.burst) buckets.delete(key);
  }

  return {
    take(key) {
      const t = now();
      if (buckets.size >= PRUNE_AT) prune(t);
      const b = buckets.get(key) ?? { tokens: limit.burst, at: t, refusing: false };
      b.tokens = level(b, t);
      b.at = t;
      buckets.set(key, b);
      if (b.tokens >= 1) {
        b.tokens -= 1;
        b.refusing = false;
        return undefined;
      }
      const first = !b.refusing;
      b.refusing = true;
      return { retryAfterS: Math.max(1, Math.ceil((1 - b.tokens) / perMs / 1000)), first };
    },
  };
}

/** The client's address, as Traefik saw it (see above). */
export function clientIp(req: http.IncomingMessage): string {
  // Node joins repeated X-Forwarded-For headers with ", ".
  const forwarded = req.headers["x-forwarded-for"];
  const last = (typeof forwarded === "string" ? forwarded : "").split(",").map((s) => s.trim()).filter(Boolean).at(-1);
  const ip = last && isIP(last) ? last : (req.socket.remoteAddress ?? "");
  return ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}

/**
 * The key an address is limited under. An IPv6 home or phone connection gets
 * a whole /64 to choose addresses from, so it is limited as one.
 */
export function addressKey(ip: string): string {
  if (isIP(ip) !== 6) return ip;
  const [head = "", tail = ""] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}
