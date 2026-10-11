// Asking auth.sdfwa.org who is signed in.
//
// The browser's cookie (Domain=.sdfwa.org) is forwarded to GET /api/session,
// which always answers 200: `{user: {...}}` when signed in, `{user: null}`
// when not. Anything else (an error status, a timeout, a body we don't
// recognise) is an outage, never "signed out": treating an outage as signed
// out would bounce members to a sign-in page that sends them straight back.
// See issue #15 for the research behind this.

export interface SessionUser {
  id: string;
  email: string;
  memberId: string | null;
  claims: string[];
}

export type Session =
  | { kind: "signed-in"; user: SessionUser }
  | { kind: "signed-out" }
  | { kind: "unavailable"; reason: string };

/** Paying members and volunteers may send photos and videos. */
export const ENTITLING_CLAIMS = ["member", "volunteer"] as const;

export function isEntitled(user: SessionUser): boolean {
  return user.claims.some((c) => (ENTITLING_CLAIMS as readonly string[]).includes(c));
}

interface AuthClientOptions {
  authBaseUrl: string;
  timeoutMs: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseUser(raw: unknown): SessionUser | undefined {
  if (!isRecord(raw)) return undefined;
  const { id, email, memberId, claims } = raw;
  if (typeof id !== "string" || typeof email !== "string") return undefined;
  if (!Array.isArray(claims) || !claims.every((c) => typeof c === "string")) return undefined;
  return { id, email, memberId: typeof memberId === "string" ? memberId : null, claims };
}

export async function checkSession(cookie: string | undefined, opts: AuthClientOptions): Promise<Session> {
  // No cookie means no session; there is nothing to ask.
  if (!cookie) return { kind: "signed-out" };

  let body: unknown;
  try {
    const res = await fetch(`${opts.authBaseUrl}/api/session`, {
      headers: { cookie, accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (res.status !== 200) return { kind: "unavailable", reason: `auth answered ${res.status}` };
    body = await res.json();
  } catch (err) {
    return { kind: "unavailable", reason: err instanceof Error ? err.name : "error" };
  }

  if (!isRecord(body) || !("user" in body)) return { kind: "unavailable", reason: "unrecognised body" };
  if (body.user === null) return { kind: "signed-out" };
  const user = parseUser(body.user);
  if (!user) return { kind: "unavailable", reason: "unrecognised user" };
  return { kind: "signed-in", user };
}

/**
 * The display name for the page header, from GET /api/user (the session
 * endpoint carries no name). Best effort: on any problem, the email.
 */
export async function displayName(cookie: string, user: SessionUser, opts: AuthClientOptions): Promise<string> {
  try {
    const res = await fetch(`${opts.authBaseUrl}/api/user`, {
      headers: { cookie, accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (res.status === 200) {
      const body: unknown = await res.json();
      const source = isRecord(body) && isRecord(body.user) ? body.user : body;
      if (isRecord(source)) {
        if (typeof source.name === "string" && source.name.trim()) return source.name.trim();
        const parts = [source.firstName, source.lastName].filter((p): p is string => typeof p === "string" && !!p.trim());
        if (parts.length) return parts.join(" ").trim();
      }
    }
  } catch {
    // fall through to the email
  }
  return user.email;
}
