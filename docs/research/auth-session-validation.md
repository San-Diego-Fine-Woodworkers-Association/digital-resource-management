# Validating an auth.sdfwa.org session from the upload proxy

Research for issue #15 (part of map #12). Facts only; no design or build.

Source roots (read-only, `Digital-Services` monorepo). Paths below are relative to it:

- `A` = `apps/auth`
- `C` = `packages/auth-client`
- `BA` = `apps/auth/node_modules/better-auth/dist` (installed 1.4.19; `package.json` asks `^1.4.18`)

## Short answer

- The proxy can validate with **one server-to-server call**: forward the browser's `Cookie` header to `GET https://auth.sdfwa.org/api/session`. The response says who is signed in and carries `claims`. The proxy then checks `claims` includes `member` or `volunteer`.
- The cookie reaches the proxy because it is `Domain=.sdfwa.org`, so media.sdfwa.org/upload receives it on every request.
- **No change to auth is needed** to accept media.sdfwa.org for `?redirect=`, CORS, or Better-Auth trusted origins. Every one of those already allows `*.sdfwa.org`.
- JWT/JWKS local verification exists and works from a non-Next service, but it has three drawbacks here: a 15-minute lifetime, no revocation check, and an extra mint step. See "JWT / JWKS option".
- Session lifetime (7 days, sliding) is not a problem for a long upload. Validate at request start; a request already in flight is not interrupted.

## 1. `GET /api/session`

Handler: `A/app/api/session/route.ts:6-31`.

Request: a plain GET with the session cookie. No body, no auth header.

```
GET https://auth.sdfwa.org/api/session
Cookie: <browser cookie header, forwarded verbatim>
```

Response, always HTTP 200 (`route.ts:10`, `docs/api-reference.md:109`):

```jsonc
// signed in (route.ts:20-30)
{ "user": { "id", "email", "memberId": string|null, "membership": string|null,
            "groups": string[], "claims": string[] },
  "expiresAt": "<session expiry>" }
// signed out, expired, or revoked (route.ts:10)
{ "user": null }
```

Things to know:

- **Signed out is a 200 with `user: null`, not a 401.** The proxy must test `user`, not the status.
- The reference client treats any non-OK response as signed out (`C/src/server.ts:82`: `if (!res.ok) return null`). That conflates "auth.sdfwa.org is down" with "signed out". A proxy that wants to tell those apart has to do so itself.
- Each call runs `enforceActiveOrRevoke` (`route.ts:8`; `A/lib/auth/enforce-active.ts:22-81`):
  - A ProClass member has `proclass_users.active` re-read from the DB. If it is false, the session row is **deleted** and `user: null` is returned (`enforce-active.ts:32-47`).
  - A volunteer has groups re-synced from Google Workspace if the last sync is more than 10 minutes old (`enforce-active.ts:10`, `55-64`). A Workspace 404 deletes the session (`66-74`). Admin API errors leave the session alive (`75-77`).
  - So a call can include a DB read and sometimes a Google Admin API call. Latency per call is not documented.
- The public response never exposes `kind`/`accountOrigin`. Authorize on `claims` (`docs/architecture.md:40-43`, `api-reference.md:125`).
- The `expiresAt` field is `session.session.expiresAt` (`route.ts:29`).
- A reference implementation of the call is `getServerSession(cookieHeader)` in `C/src/server.ts:75-86`. It is about 10 lines of `fetch` and has no Next dependency. `requireClaim(cookieHeader, ["member","volunteer"])` (`server.ts:117-129`) is the exact check needed. It throws `"Unauthorized"` (signed out) or `"Forbidden"` (signed in without a matching claim), which maps cleanly to 401 and 403.

### Cookie details

- Cookie is Better-Auth's session token, `HttpOnly`, `SameSite=Lax`, `Domain=COOKIE_DOMAIN` which is `.sdfwa.org` in prod (`A/lib/auth.ts:133-140`; `docs/dokploy-deployment.md:60`; `docs/architecture.md:147-154`).
- **Name discrepancy.** `docs/architecture.md:152` names it `better-auth.session_token`. Better-Auth adds a `__Secure-` prefix when `baseURL` starts with `https://` (`BA/cookies/index.mjs:17`), and prod `BETTER_AUTH_URL` is `https://auth.sdfwa.org` (`dokploy-deployment.md:58`). So in prod the cookie is very likely `__Secure-better-auth.session_token`. Inferred from library source, not observed on the live site. A proxy that forwards the whole `Cookie` header does not care. One that picks a cookie by name does.
- The cookie value is signed and the session is stored in the DB. The proxy cannot validate it locally; it would need `BETTER_AUTH_SECRET` and DB access, and should not have either. Always ask the auth app.
- A browser request to `media.sdfwa.org` carries the cookie because it is same-site (subdomains of `sdfwa.org`) and the cookie's domain covers it. Whether Traefik strips or alters the `Cookie` header on its way to the proxy is not an auth-side concern, but worth confirming.

## 2. JWT / JWKS option

Source: `docs/architecture.md:118-130`, `docs/integrating-apps.md:221-237` (marked "(Future)... implemented but currently optional"), `A/lib/auth.ts:143-165`, `C/src/verify.ts`.

- **Mint:** `POST https://auth.sdfwa.org/api/auth/jwt-refresh` with the session cookie returns `{ "token": "<jwt>" }` (`A/app/api/auth/jwt-refresh/route.ts:13-28`). It runs `enforceActiveOrRevoke` first and returns 401 for no session or a deactivated member (`route.ts:16-19`). Called from the browser at media.sdfwa.org it is covered by the CORS middleware (`A/middleware.ts:6,22-24`; `A/lib/cors.ts:12-22`).
- **JWKS:** `GET https://auth.sdfwa.org/api/auth/jwks`, EdDSA keys (`auth.ts:144`; `api-reference.md:260-263`).
- **Payload:** `sub` (user id), `email`, `memberId`, `membership`, `claims`, `groups`, plus `iat`/`exp`/`iss`/`aud` (`auth.ts:148-163`; `C/src/verify.ts:19-26`).
- **Lifetime:** 15 minutes default. Better-Auth default `expirationTime ?? "15m"` (`BA/plugins/jwt/sign.mjs:14`); the auth app does not override it.
- **`iss` and `aud`:** both default to the auth `baseURL`, i.e. `https://auth.sdfwa.org` (`BA/plugins/jwt/sign.mjs:18,20`). `verifyJwt` checks `iss` only and does **not** check `aud` (`C/src/verify.ts:42-44`). The proxy could pass an audience check to `jose` itself.
- **Local verification** is `verifyJwt(token, { authBaseUrl })` (`C/src/verify.ts:32-49`), using `jose` `createRemoteJWKSet` and `jwtVerify`. `jose` runs on any Node/Bun/Deno service. JWKS is cached by the helper for one hour (`verify.ts:8,10-17`). `payloadToSessionUser` (`verify.ts:51-60`) yields the same shape as `/api/session`.
- Trade-offs relevant to the proxy:
  - The token is a bearer the SPA must fetch, hold in memory, refresh every 15 min, and send in an `Authorization` header, instead of the proxy just reading the cookie it already receives.
  - A JWT already minted stays valid for up to 15 min after the session is revoked (member deactivated, logout, Workspace removal). The cookie-forward call revokes immediately.
  - The claims in the JWT are the same snapshot as `/api/session` (see section 7), so JWT adds no freshness over the cookie call.
  - It saves one HTTP round trip per request to the auth app. For a low-traffic upload form that may not matter.

## 3. Claims available

Derivation: `A/lib/auth/entitlement.ts:53-62`; docs `architecture.md:49-73`.

| Claim | When present |
| --- | --- |
| `volunteer` | Signed in via Google with an `@sdfwa.org` account (`entitlement.ts:59`; Google `hd` check, `auth.ts:12,77-82`) |
| `member` and `tier:<level>` (bronze, silver, gold, lifetime) | ProClass contact whose `membership` string maps to a tier (`entitlement.ts:32-40,60`) |
| none (`[]`) | ProClass contact with no Active tier. Signed in but not entitled (the "upsell state") |

- Authentication is not entitlement. A valid session with `claims: []` is common ("a minority of signed-in ProClass contacts" hold `member`; `integrating-apps.md:88-94`). The proxy should return 403, not treat it as signed out, and the SPA needs a "you need an active membership" message distinct from "sign in".
- `groups: string[]` carries Workspace group names for volunteers (`[]` otherwise). Not needed for the `member` or `volunteer` rule.
- Identity for Submitter attribution: `user.id` (stable), `email`, and `memberId` (null for volunteers). `/api/session` has no display `name`; `GET /api/user` has `name`, `firstName`, `lastName` (`api-reference.md:143-172`; `C/src/types.ts:207-220`) and is also cookie-authenticated, so the proxy can fetch it if a display name is wanted.

## 4. Login redirect flow

- Entry point: `https://auth.sdfwa.org/login?redirect=<url-encoded absolute URL>` (`docs/integrating-apps.md:239-270`; `A/app/login/page.tsx:14-17`).
- If already signed in, `/login` immediately redirects to the target (`login/page.tsx:16-17`).
- After sign-in the login form navigates to `redirectTo` via `window.location.href` (`A/components/login-form.tsx:46,85`) or passes it as the Google `callbackURL` (`login-form.tsx:69`).
- Use an **absolute** URL. A relative path passes validation but resolves against auth.sdfwa.org (`integrating-apps.md:245-248`). So the redirect must be `https://media.sdfwa.org/upload` (plus any path/query the SPA wants back; `url.toString()` is returned intact, `safe-redirect.ts:29`).
- The member path may take a detour: first sign-in on a new browser sends a magic link by email (15 min TTL); the original tab polls and then redirects (`architecture.md:91-107`). A phone user who opens the email link in a different app/browser gets signed in on that browser, and the original tab completes by polling. This affects the flow but not the validation call.
- Omitting `redirect` lands on `POST_LOGIN_DEFAULT_REDIRECT`, `https://www.sdfwa.org` in prod (`dokploy-deployment.md:63`).

## 5. `safe-redirect` and whether auth must change

`A/lib/safe-redirect.ts:7-30`. Allowed targets:

- Relative paths starting with a single `/` (`//` is rejected, line 13).
- `http:` or `https:` URLs whose hostname is `sdfwa.org`, ends with `.sdfwa.org`, or is `localhost` / `127.0.0.1` (lines 21-28).
- Everything else falls back to `POST_LOGIN_DEFAULT_REDIRECT` (or `/`).

`media.sdfwa.org` ends with `.sdfwa.org`, so it is accepted **with no change**. The same function guards `/logout` (`A/app/logout/route.ts:23`). Other auth-side allow-lists also already cover it:

- CORS: `A/lib/cors.ts:12` allows any `*.sdfwa.org` origin with credentials, on `/api/session`, `/api/user`, `/api/auth/*` (`A/middleware.ts:6,22-24`).
- Better-Auth `trustedOrigins` include `https://*.sdfwa.org` (`A/lib/auth.ts:57-64`).
- Tests for safe-redirect: `A/__tests__/safe-redirect.test.ts`.

Note that the allow-list is domain-wide, so any `*.sdfwa.org` host can be redirect targets. Nothing media-specific is checked.

## 6. Logout

- Recommended: a plain link or navigation to `https://auth.sdfwa.org/logout?redirect=https://media.sdfwa.org/upload` (`docs/integrating-apps.md:276-294`; handler `A/app/logout/route.ts:22-42`). It signs out server-side, forwards the cookie-clearing `Set-Cookie` headers onto a 302, and uses the same `safeRedirect`.
- Alternative: `POST https://auth.sdfwa.org/api/auth/sign-out` with `Content-Type: application/json` and `credentials: "include"` from the SPA, then a hard navigation (`integrating-apps.md:300-330`). CORS allows it (`architecture.md:156-163`).
- Sign-out deletes the **session** only; the `sdfwa_device_id` cookie survives, so on a trusted device (trust lasts 90 days, `architecture.md:102`) the user can sign straight back in without a magic link (`integrating-apps.md:296-298`). On a shared family or shop device this means "log out" does not require the member to re-verify by email.
- With cookie-forward validation, logout takes effect on the proxy's next call. A previously minted JWT would stay valid up to 15 minutes.

## 7. Session lifetime vs a long upload

The auth app sets no `session` options (`A/lib/auth.ts:53-167`), so Better-Auth defaults apply (`BA/context/create-context.mjs:120-123`):

- `expiresIn`: **7 days**.
- `updateAge`: **1 day**. A session read more than a day after the last extension rolls the expiry forward (`BA/api/routes/session.mjs:205-206`), but only if the read goes through Better-Auth's session lookup, which `/api/session` does (`A/lib/auth/get-session.ts:5-7`).
- No `cookieCache` is configured, so every call hits the DB (the revocation check also does).
- The member sign-in plugin creates sessions with `createSession(user.id, false)` (`A/lib/auth/member-login-plugin.ts:189,286,335`), the normal "remember me" lifetime.

Consequences for a long upload:

- A signed-in user will not hit the 7-day expiry mid-upload unless they were within hours of it; the next validated call also extends it.
- **Validate when each request starts**, not by holding the session open. An HTTP request already in flight is not cut off if the session is revoked or expires after it began. With many sequential per-Item requests (or chunks), each one re-validates, so revocation applies at the next one.
- If the proxy instead caches validation per Submission to save round trips, the cached identity can outlive a revocation. The auth-side revocation window is "one ETL cycle (default hourly) plus the next consumer request" for members, and about 10 minutes for volunteer group changes (`architecture.md:132-145`).
- The JWT option cannot span a long upload: 15 minutes, so the SPA would have to refresh tokens during an upload.
- Magic-link sessions: the link itself expires in 15 minutes (`architecture.md:93-95`), but that only matters at sign-in.

## Open risks and unknowns

1. **Claims are a sign-in snapshot.** `user.membership` is written at member sign-in (`A/lib/auth/member-login-plugin.ts:131-167`). The ETL upserts `proclass_users` only (`A/lib/proclass/sync.ts:30-70`; no write to the `user` row found). The only live check is `proclass_users.active` (`enforce-active.ts:32-47`). A member whose tier changes (for example to none) but whose contact stays active keeps the old `claims` until they next sign in. Likewise a volunteer's claim persists as long as the Workspace account exists. Not verified end to end; worth a confirm with the auth owner if a lapsed membership must be locked out quickly.
2. **Cookie name** in prod is likely `__Secure-better-auth.session_token`, which differs from the docs. Inferred from library source (`BA/cookies/index.mjs:17`); confirm on the live site if the proxy ever picks the cookie by name.
3. **`@sdfwa/auth-client` is a private workspace package** (`C/package.json:2-4`, `exports` at lines 31-36) in another repo. This repo cannot depend on it as-is. The needed logic (`getServerSession` + claim check) is about 25 lines of plain `fetch`; copying it, or publishing the package, is a decision for later. For the JWT path, `jose` is the only dependency (`C/package.json:9-11`).
4. **Per-request latency and load on auth** are not documented. Each `/api/session` hit does DB reads and, for volunteers with stale groups, a Google Admin API call (`enforce-active.ts:55-64`). Unknown whether a per-chunk call pattern is acceptable. Worth asking the owner or measuring.
5. **Distinguishing outage from signed-out.** `/api/session` returns 200 `{user:null}` for signed out, and the reference client maps any non-OK to signed out (`C/src/server.ts:82`). A proxy that copies it verbatim would show "sign in" during an auth outage. Needs deliberate handling (fail closed with a 503, not a sign-in loop).
6. **Who triggers the sign-in redirect** (SPA reading `/api/session` from the browser vs the proxy answering 401 vs a Traefik ForwardAuth gate) is a design choice not settled here. Browser calls to `auth.sdfwa.org/api/session` from media.sdfwa.org are allowed by CORS with credentials (`cors.ts:12,18-19`); the `SameSite=Lax` cookie is sent because the sites are same-site. Not tested against the live deployment.
7. **Magic-link flow on phones** (open the email link in a different browser than the one that started sign-in, relying on polling in the original tab) was read from docs (`architecture.md:91-107`), not exercised. It is the highest-friction part of login for the target audience, though outside the proxy's validation.
8. **Logout leaves the device cookie** (see section 6). Relevant if the form is used on shared devices.
9. The JWT audience is not checked by the shipped `verifyJwt` (`C/src/verify.ts:42-44`). Only relevant if the JWT option is chosen.
