# Operating the Member Media Upload service

The `upload` service serves the member upload page at
`https://media.sdfwa.org/upload` and its small API. Members send photos and
videos; each one becomes an Item in Pending Review (Quarantine) in
ResourceSpace, and the Reviewers get one email per Submission.

This page is the reference for whoever looks after it. The runbooks for when
something goes wrong are in [`runbooks/`](runbooks/):

- [Staging is full](runbooks/staging-full.md)
- [ResourceSpace is down](runbooks/resourcespace-down.md)
- [The Reviewers' email did not arrive](runbooks/reviewer-email-missing.md)

Words like Submission, Item, Reviewer and Quarantine are defined in
[`CONTEXT.md`](../CONTEXT.md). Design decisions are in the ADRs:
[0001](adr/0001-upload-proxy-with-tus-chunking.md) (the proxy),
[0002](adr/0002-quarantine-is-native-pending-review.md) (Pending Review),
[0004](adr/0004-isolated-staging-volume.md) (staging volume),
[0006](adr/0006-reviewer-notification-by-workspace-smtp-relay.md) (email).

**Contents:** [How it fits together](#how-it-fits-together) ·
[Deploying](#deploying) · [Getting onto the server](#getting-onto-the-server) ·
[Environment variables](#environment-variables) ·
[Kill switches](#kill-switches) · [Limits and quotas](#limits-and-quotas) ·
[Staging volume](#the-staging-volume) · [Logs and the audit trail](#logs-and-the-audit-trail) ·
[Health endpoint](#the-health-endpoint) · [Reviewers' email](#the-reviewers-email) ·
[Adding a Reviewer](#adding-or-removing-a-reviewer) · [Patching](#patching) ·
[Monitoring](#monitoring) · [Known accepted gaps](#known-accepted-gaps)

## How it fits together

```
member's browser ──► Traefik ──► upload service ──► ResourceSpace (Pending Review)
                    (/upload only)   │    │
                                     │    └──► staging volume (/mnt/upload-staging)
                                     ├──► auth.sdfwa.org (who is signed in)
                                     └──► Google Workspace SMTP relay ──► media-reviewers@sdfwa.org
```

- Traefik sends only `/upload` and `/upload/...` to this service. ResourceSpace
  keeps every other path on `media.sdfwa.org`.
- Every page load and API call checks the member's SDFWA sign-in with
  `auth.sdfwa.org`.
  Members and volunteers may send; anyone else sees the renew-your-membership
  page.
- A file arrives in 5 MB chunks (tus) onto the staging volume. When it has all
  arrived, the service creates the Item in ResourceSpace as the
  `upload-service` user, uploads the file, writes the fields, reads them back,
  and deletes the staged file.
- The service runs as UID 10001 with a read-only root filesystem, no
  capabilities, 512 MB of memory, 1 CPU and 128 processes. The only place it
  writes is staging.

Source: `upload/` (server in `upload/server/`, page in `upload/web/`). To
develop: in `upload/`, `npm ci`, then `npm run typecheck`, `npm test`,
`npm run build`.

## Deploying

**A merge to `main` deploys** (Dokploy, Docker compose). Compose recreates only
the services whose definition or image changed; see the
[README](../README.md#deployments). Settings live in Dokploy's
**Environment** tab for the stack. The service reads them once at startup, so a
changed value takes effect only when the `upload` container is recreated
(redeploy the stack from Dokploy). Saving environment variables doesn't
restart anything by itself: press **Deploy** (redeploy) to apply them. _To
confirm in the Dokploy UI._

A redeploy that recreates the `upload` container:

- forgets the quotas held in memory (see [Limits](#limits-and-quotas));
- stops any hand-off running in the background. The member's page shows
  Couldn't save, and **Try again** finishes it into the same Item;
- **deletes the container's log**, which holds the audit trail (see
  [Logs](#logs-and-the-audit-trail)). Save it first if you need it.

### First deploy on a new server

1. **Host:** attach the 50 GB staging volume and mount it, and set up the SMTP
   relay: [host-setup.md](host-setup.md).
2. **ResourceSpace:** create the fields, groups and the `upload-service` user
   with `RS_SSH=root@<host> scripts/rs-setup.sh provision`, then `verify`:
   [resourcespace-setup.md](resourcespace-setup.md).
3. **Dokploy Environment:** set `UPLOAD_STAGING_PATH` (the deploy fails without
   it) and the secret `RS_UPLOADER_API_KEY` (copy it from Admin > Users >
   upload-service). Everything else has a working default.
4. **Deploy**, then check `https://media.sdfwa.org/upload/health` answers 200
   with `"status":"ok"`.
5. **Mail:** `HOST_SSH=root@<host> scripts/host-setup.sh mail-test media-reviewers@sdfwa.org`,
   then send two photos through the page and confirm the Reviewers' email
   arrives.

## Getting onto the server

There is one production host. Its public IPv4 and IPv6 are in the Hetzner
Cloud console, under the project's server. The examples here set it once:

```sh
HOST=root@<server IP>
```

Scripts in this repo take the host the same way: `HOST_SSH=$HOST
scripts/host-setup.sh ...` and `RS_SSH=$HOST scripts/rs-setup.sh ...`.

There is no helper script for the upload container yet. Find it by its compose
service label, the way `scripts/rs-setup.sh` finds ResourceSpace:

```sh
ssh $HOST 'docker ps -a --filter label=com.docker.compose.service=upload --format "{{.Names}}\t{{.Status}}"'
```

That lists exactly one container, `<stack>-upload-1` (checked 2026-10-15).
Each service label in the stack (`upload`, `resourcespace`, `mariadb`,
`backup`, `clip`, `faces`, `adminer`) is unique on the host.

The container's log (both the audit trail and the operational messages):

```sh
ssh $HOST 'docker logs --since 24h $(docker ps -q --filter label=com.docker.compose.service=upload) 2>&1'
```

## Environment variables

Every variable the service reads is in `upload/server/config.ts`. A bad value
stops the service from starting, with a message naming the variable, rather
than running half-configured. An empty value means "use the default".

"In compose" says whether `docker-compose.yaml` passes the variable through
from Dokploy's Environment tab. Variables marked **no** keep their default
unless compose is changed; the defaults are the production values.

### Set in Dokploy for the stack (compose only)

These are read by `docker-compose.yaml`, not by the service.

| Variable | Default | What it does |
|---|---|---|
| `UPLOAD_STAGING_PATH` | **none, required** | Host path of the staging volume, bind-mounted at `/staging`. Production: `/mnt/upload-staging` (#35). The whole compose deploy fails until it is set. Never put it on tmpfs: tmpfs counts against the container's 512 MB and gets it killed. |
| `DOMAIN_NAME` | none (shared with ResourceSpace) | The site's host. The service gets `PUBLIC_BASE_URL=https://${DOMAIN_NAME}`, and Traefik routes `/upload` on it. |
| `UPLOAD_AUTH_BASE_URL` | `https://auth.sdfwa.org` | Passed as `AUTH_BASE_URL`. |
| `UPLOAD_RS_BASE_URL` | `http://resourcespace` | Passed as `RS_BASE_URL`. |
| `UPLOAD_RENEW_URL` | `https://sdfwa.org/sdfwa-membership-levels/` | Passed as `RENEW_URL`. |

### Read by the service

| Variable | Default | In compose | What it does |
|---|---|---|---|
| `PUBLIC_BASE_URL` | `https://media.sdfwa.org` | fixed: `https://${DOMAIN_NAME}` | Where members reach the site. Every link the service hands out (sign-in, the email's review link) starts with it. |
| `AUTH_BASE_URL` | `https://auth.sdfwa.org` | yes, as `UPLOAD_AUTH_BASE_URL` | The SDFWA auth service. |
| `RS_BASE_URL` | `http://resourcespace` | yes, as `UPLOAD_RS_BASE_URL` | Where the service calls ResourceSpace: straight over the Docker network. If ResourceSpace ever refuses that, set `https://${DOMAIN_NAME}` to go through the public address. |
| `RS_HOST_HEADER` | the host of `PUBLIC_BASE_URL` | no | The `Host` header sent to ResourceSpace, so it answers as the public site. |
| `RENEW_URL` | `https://sdfwa.org/sdfwa-membership-levels/` | yes, as `UPLOAD_RENEW_URL` | Where a member whose membership has lapsed goes to renew. |
| `RS_UPLOADER_USER` | `upload-service` | yes | The ResourceSpace user every Item is created as. |
| `RS_UPLOADER_API_KEY` | empty | yes | **Secret.** That user's API key, from Admin > Users > upload-service. Keep it only in Dokploy. If empty, the deploy still succeeds, but the service refuses uploads, members see the busy page, and `/upload/health` shows `"configured": false`. The key changes if the user is recreated or `API_SCRAMBLE_KEY` changes. |
| `UPLOADS_PAUSED` | `false` | yes | The [kill switch](#kill-switches) for uploads. |
| `STAGING_DIR` | `/staging` | fixed: `/staging` | Staging inside the container. Leave it. |
| `STAGING_CAP_PERCENT` | `80` (0–100) | yes | Staging counts as full at this share of the volume. |
| `PORT` | `8080` | no (the image sets 8080) | The port the service listens on. Traefik's label expects 8080. |
| `WEB_ROOT` | the built page inside the image | no | Where the built page is. Leave it. |
| `AUTH_TIMEOUT_MS` | `5000` (1–60000) | no | How long to wait for the auth service. |
| `RS_TIMEOUT_MS` | `3000` (1–60000) | no | How long the "is ResourceSpace up?" check waits (health, and the gate on new uploads). |
| `RS_API_TIMEOUT_MS` | `120000` (1–600000) | no | How long a ResourceSpace API call may go without a byte of answer. |
| `RS_UPLOAD_TIMEOUT_MS` | `900000` (15 min; 1–3600000) | no | The same for the file upload, which ResourceSpace answers only after making the previews: minutes for a long video. |
| `HANDOFF_WAIT_MS` | `5000` (0–60000) | no | How long the hand-off request waits before answering "finishing" and carrying on in the background. The page then polls. |
| `RS_PHOTO_RESOURCE_TYPE` | `1` | no | ResourceSpace's resource type for photos. |
| `RS_VIDEO_RESOURCE_TYPE` | `3` | no | ResourceSpace's resource type for videos. |
| `PHOTO_MAX_BYTES` | 50 MiB (52428800) | no | Largest photo. Can only be lowered. |
| `VIDEO_MAX_BYTES` | 1 GiB (1073741824) | no | Largest video. Can only be lowered. |
| `SUBMISSION_MAX_ITEMS` | `50` | no | Photos and videos per Submission. Can only be lowered. |
| `SUBMISSION_MAX_VIDEOS` | `10` | no | Videos per Submission. Can only be lowered. |
| `SUBMISSION_MAX_BYTES` | 4 GiB (4294967296) | no | Bytes per Submission. Can only be lowered. |
| `QUOTA_UPLOADS_AT_ONCE` | `2` (1–10) | yes | Uploads one member may have receiving bytes at the same moment. |
| `QUOTA_STAGED_BYTES` | 4 GiB (4294967296) | yes | Bytes one member may have on staging at once. |
| `QUOTA_DAILY_ITEMS` | `100` | yes | Items one member may send in any 24 hours. |
| `QUOTA_DAILY_BYTES` | 10 GiB (10737418240) | yes | Bytes one member may send in any 24 hours. |
| `QUOTA_DAILY_SUBMISSIONS` | `50` | yes | Submissions one member may start in any 24 hours. |
| `RATE_USER_PER_MINUTE` | `600` | yes | API requests per member per minute (token bucket refill). |
| `RATE_USER_BURST` | `300` | yes | ...and how many at once. |
| `RATE_IP_PER_MINUTE` | `1200` | yes | Requests per address per minute (page, health and API; not the built files). |
| `RATE_IP_BURST` | `600` | yes | ...and how many at once. |
| `REVIEWER_EMAIL_PAUSED` | `false` | yes | The [kill switch](#kill-switches) for the Reviewers' email. |
| `SMTP_HOST` | `smtp-relay.gmail.com` | yes | The relay. A bare host name. |
| `SMTP_PORT` | `587` | yes | STARTTLS is required. Hetzner blocks 25 and 465. |
| `SMTP_EHLO_NAME` | `media.sdfwa.org` | yes | The name the service gives the relay. |
| `REVIEWER_EMAIL_FROM` | `no-reply@sdfwa.org` | yes | Sender. One bare address. |
| `REVIEWER_EMAIL_TO` | `media-reviewers@sdfwa.org` | yes | The Reviewers' Google Group. One bare address. |
| `REVIEWER_EMAIL_STALL_MINUTES` | `30` (1–1440) | yes | Send a partial email after this long with nothing arriving. |

The limits (`PHOTO_MAX_BYTES` to `SUBMISSION_MAX_BYTES`) are the decided
values the page also shows. Lowering one makes the service stricter than what
the page tells members, so change them only for testing.

## Kill switches

Both are off only for `false`, `0`, `no`, `off` or empty (any case). **Any
other value, a typo included, turns the switch on.** Set them in Dokploy's
Environment tab and redeploy.

### `UPLOADS_PAUSED`: stop taking uploads

Use it when something is wrong and you want members to stop sending while you
look: staging filling, ResourceSpace misbehaving, a bad release.

While on:

- Anyone opening `/upload` sees "Sharing is paused for a little while. Please
  come back later." (HTTP 503).
- Every write to the API is refused with 503 `paused`. A page that was already
  sending treats it as busy and keeps retrying for a few minutes, then offers
  **Try again**.
- Reads still work, so a page can still see how a running hand-off ends.
- Staged uploads stay on staging. The hourly sweep still runs.
- The Reviewers' email for a Submission already under way still goes when it
  stalls.
- `/upload/health` still answers 200 if all else is well, with
  `"paused": true`.

Turn it off (`UPLOADS_PAUSED=false`) and redeploy to resume. Remember the
redeploy itself [restarts the service](#deploying).

### `REVIEWER_EMAIL_PAUSED`: stop the Reviewers' email

While on, nothing is scheduled or sent. Uploads carry on as normal. Submissions
started while it is on never get an email, even after it is turned off; their
Items are still in Pending Review. Emails already scheduled when you turn it on
are not sent while it is on. When it is turned off again, those still pending
on staging are read back at startup and sent.

> **Until #84 is deployed:** while the switch is on, the sweep doesn't know
> those emails are pending, so one whose state file hasn't changed for 24
> hours is removed and never sent. Keep the pause short, or tell the Reviewers
> to check Pending Review.

## Limits and quotas

Decided in #18 (limits) and #23/#60 (quotas). All tunable values are in the
[table above](#environment-variables).

### Per Submission and per file

| Limit | Value | Refusal (`error`) | HTTP |
|---|---|---|---|
| Photo size | 50 MB | `too_big` | 413 |
| Video size | 1 GB | `too_big` | 413 |
| Total size of a Submission | 4 GB | `too_much_in_all` | 413 |
| Items per Submission | 50 | `too_many` | 422 |
| Videos per Submission | 10 | `too_many_videos` | 422 |
| File type (by content) | JPEG, PNG, HEIC/HEIF, MP4, MOV | `wrong_type` | 415 |

The member sees "Can't be added" with the reason and **Remove**.

### Per member, and the server's own protection

| Limit | Default | When it is checked | HTTP, `error` | Retry-After (s) |
|---|---|---|---|---|
| Uploads receiving at once | 2 | each chunk | 429 `too_many_at_once` | 15 |
| Bytes on staging at once | 4 GiB | upload start and each chunk | 429 `too_much_staged` | 60 |
| Items sent in any 24 h | 100 | upload start | 429 `too_many_today` | until there is room |
| Bytes sent in any 24 h | 10 GiB | upload start | 429 `too_much_today` | until there is room |
| Submissions started in any 24 h | 50 | Send | 429 `too_many_today` | until there is room |
| Requests per member | 600/min, burst 300 | every API call | 429 `rate_limited` | to the next token |
| Requests per address | 1200/min, burst 600 | page, health, API | 429 `rate_limited` | to the next token |
| Staging cap | 80% of the volume, and the chunk must fit in the free space | upload start and each chunk | 503 `busy` | 120 |
| ResourceSpace not answering | | page load, Send, upload start | 503 `unavailable` | 30 |

Every limit lifts by itself: a chunk finishes, a file is handed over, or time
passes. An IPv6 address is limited by its /64. The address is the one Traefik
saw (the last `X-Forwarded-For` entry); see the note in
`upload/server/ratelimit.ts` if a CDN is ever put in front.

### How the day is counted

- **"In any 24 hours" is a sliding window**, not a calendar day.
- **The Items and bytes quotas count what reached ResourceSpace**, plus what is
  in flight. An upload holds its place from the moment it starts until it is
  either sent (the hold becomes a sent record) or leaves staging unsent (the
  hold is let go). A new upload is refused when sent-in-the-last-24-hours plus
  held would go over. So starting many at once can't beat it.
- **A failed upload keeps its place.** A hand-off that didn't save
  (Couldn't save) keeps its hold while the file is still on staging, because
  **Try again** can still send it. The hold goes when the member removes it, or
  when the sweep removes it after 24 hours idle. A failed upload that is later
  sent counts once.
- Uploads the member takes out, ones refused at the hand-off, and ones left to
  the sweep never count.
- **Submissions** count when started, whatever happens to them, because each
  leaves a small record on staging.
- **All of this is held in memory and forgotten on a restart** (decided on
  #23). At startup the service counts what is on staging again, so the
  per-member staged bytes and the in-flight holds come back; the sent history
  does not. See [Known accepted gaps](#known-accepted-gaps).

## The staging volume

Untrusted files land here before ResourceSpace sees them
([ADR 0004](adr/0004-isolated-staging-volume.md)). It is a dedicated 50 GB
Hetzner Volume, so if it fills, only uploads stop; the database, filestore,
backups and root disk are untouched.

| | Production (#35, checked 2026-10-15) |
|---|---|
| Host path | `/mnt/upload-staging` (`UPLOAD_STAGING_PATH`) |
| In the container | `/staging` |
| File system | ext4, mounted `noexec,nosuid,nodev,nofail,discard` |
| Owner | `10001:10001`, mode `0750` |
| Set up by | `scripts/host-setup.sh staging <device>`, see [host-setup.md](host-setup.md) |

**It is `nofail`: after a reboot, check it is mounted** (`HOST_SSH=$HOST
scripts/host-setup.sh check`, section "Staging mount"). If it is not, the
service would see the empty, root-owned directory on the root disk underneath;
it cannot write there (it runs as 10001), so health should report
`"writable": false`. (Reasoned from the fstab and the ownership, not observed:
checking it would need an unmount.)

### The cap

The service stops itself at `STAGING_CAP_PERCENT` (80%, about 40 GB of 50).
Before each chunk it checks the chunk fits under the cap **and** in the space
free to its user, with a 16 MiB margin. Past either, the member gets 503 `busy`
("We're busy right now"), and nothing is written. Several chunks checked at the
same moment may overshoot the cap by a few chunks; the 20% above it covers
that.

### What is on it

Every name is made by the service:

| File | What it is |
|---|---|
| `<upload id>` and `<upload id>.json` | a photo or video arriving or arrived (32 hex characters), and tus's record of it |
| `<upload id>.item.json` | its hand-off record: the ResourceSpace ref once it exists, and each step done |
| `<submission id>.submission.json` | a Submission's answers from Steps 2 and 3 (12 characters) |
| `<submission id>.notify.json` | the state of its Reviewers' email |
| `....json.tmp` | a record being written |

Records hold members' names, emails and answers. Treat the volume as personal
data.

### The sweep

It runs **at startup and every hour**, and only ever removes plain files with
the names above. It never touches a directory (`lost+found`), a link, or any
other file, so it cannot remove anything it did not make.

| What | Kept while | Removed |
|---|---|---|
| An upload (arriving, arrived, or a hand-off that stopped partway) | it had a chunk or a hand-off step in the last 24 h | 24 h after that, with its hand-off record. One that got as far as ResourceSpace is logged with its ref, for a Reviewer to clear |
| A hand-off record whose upload is gone (sent or given up) | 24 h, so the page can still hear "sent" | after 24 h |
| A Submission record | an upload on staging belongs to it, or it took one in the last 24 h, or it is under 24 h old, or its email is still to go | after all of those |
| An email state file | its email is still to go | 24 h after it went |
| Leftovers: half an upload, an upload record the service did not write, a half-written record | | at startup at once; while running, once an hour old |

A sweep that removed anything logs `staging sweep` with how many it removed and
kept.

## Logs and the audit trail

Everything goes to the container's log: the Docker `json-file` driver, on the
root disk, rotated at **5 files of 20 MB** (about 300,000 audit lines). Read it
with `docker logs` ([Getting onto the server](#getting-onto-the-server)).

**The log goes with the container.** Docker deletes a container's log when the
container is removed, and a redeploy that changes the `upload` service
recreates it. A member hitting refusals at the allowed rate could also rotate
older lines out within hours. Shipping logs off the host is #80. Until then, if
you need the trail (an incident, a complaint), save it before redeploying:

```sh
ssh $HOST 'docker logs $(docker ps -q --filter label=com.docker.compose.service=upload) 2>&1' > upload-log-$(date +%F).jsonl
```

### Audit lines (stdout)

One JSON object per line, with `"audit":true`. Only these fields are ever
written, so no file contents, cookies or keys can appear:

```json
{"audit":true,"time":"2026-10-14T18:02:11.512Z","event":"upload_request","outcome":"sent","method":"POST","path":"/upload/api/items","user":{"id":"…","email":"…","memberId":"…"},"submissionId":"…","uploadId":"…","sizeBytes":3145728,"detectedType":"image/jpeg","ip":"203.0.113.7"}
```

| `event` | When | `outcome` values |
|---|---|---|
| `upload_request` | every write to the API (not reads, and not each tus chunk; one line when an upload starts) | `submission_started`, `created` (an upload started), `finishing` then `sent` (a hand-off), `finished` (the page finished with some not sent), and the refusals: `paused`, `auth_unavailable`, `signed_out`, `not_member`, `not_configured`, `rs_unreachable`, `busy`, `invalid`, `invalid_details`, `rights_required`, `not_found`, `incomplete`, `not_saved`, `unavailable`, and each limit's `error` from [Limits](#limits-and-quotas) |
| `reviewer_email` | the Reviewers' email went, or was given up | `sent_complete`, `sent_partial`, `sent_unknown`, `failed` |

Rate-limited requests are **not** audited (a flood would push the trail out of
the log); the first refusal in a run logs `rate limit reached` once.

Useful filters:

```sh
… | grep '"audit":true' | grep '"outcome":"sent"'          # Items that reached ResourceSpace
… | grep '"audit":true' | grep '"email":"member@example.org"'   # one member's activity
… | grep '"event":"reviewer_email"'                       # every Reviewers' email
```

### Operational messages (stderr)

One JSON object per line: `{"time":…,"message":…, …fields}`. The ones worth
knowing:

| Message | Meaning |
|---|---|
| `upload service listening` | Started. Shows `paused` and `resourcespaceKeySet`. |
| `RS_UPLOADER_API_KEY is not set: …` / `refusing uploads: RS_UPLOADER_API_KEY is not set` | The secret is missing. |
| `auth service unavailable` | `auth.sdfwa.org` did not answer properly. Members see the busy page. |
| `rate limit reached` | A member or address hit its limit. Logged once per run. |
| `could not save to ResourceSpace` | A hand-off failed; the member sees Couldn't save. Carries ResourceSpace's error. |
| `ResourceSpace failed during a hand-off; trying again` | The service's own retry (after 1 s and 3 s). |
| `fields not confirmed on the Item after retrying; counted as received` | A field did not stick. A Reviewer fills it in at Approval. |
| `… it may hold an empty Item from it` | The [lost-create gap](#known-accepted-gaps). |
| `gave up on an Item partway to ResourceSpace: …` | The sweep removed an upload whose Item exists without everything. The `ref` is logged for a Reviewer to clear. |
| `staging sweep` / `staging sweep failed` / `could not clean up staging at startup` | The sweep. |
| `could not send the reviewer email` | One failed try, with the relay's error. |
| `no reviewer email: nothing in the Submission arrived` | A Submission stalled with nothing in ResourceSpace: nothing to review, nothing sent. |
| `reviewer email still to send after a restart` | Re-armed at startup. |
| `could not schedule the reviewer email` / `could not save the reviewer email's state` | The email for that Submission may not go. |
| `could not read the choices from ResourceSpace` | ResourceSpace did not give the list-field options. |
| `request failed` / `hand-off failed` | An unexpected error. Worth reading. |

## The health endpoint

`GET https://media.sdfwa.org/upload/health`, public, no sign-in. It answers
**200** when the service could take an upload and **503** (`"degraded"`) when
it could not.

```json
{
  "status": "ok",
  "paused": false,
  "resourcespace": { "reachable": true, "configured": true },
  "staging": {
    "ok": true, "writable": true,
    "usedBytes": 563773440, "totalBytes": 52576092160,
    "usedPercent": 1.1, "capPercent": 80
  }
}
```

| Field | `ok` needs | If not |
|---|---|---|
| `resourcespace.reachable` | ResourceSpace's front page answered without a 5xx within `RS_TIMEOUT_MS` | [ResourceSpace is down](runbooks/resourcespace-down.md) |
| `resourcespace.configured` | `RS_UPLOADER_API_KEY` is set | Set the secret in Dokploy and redeploy |
| `staging.writable` | the service can write to `/staging` | Staging not mounted, or wrong owner: [Staging is full](runbooks/staging-full.md) |
| `staging.usedPercent` | below `capPercent` | [Staging is full](runbooks/staging-full.md) |
| `paused` | (does not affect `status`) | `UPLOADS_PAUSED` is on |

- The ResourceSpace answer is remembered for 15 s (5 s after a failure) and
  shared with the gate on new uploads, so polling health cannot keep
  ResourceSpace busy.
- Health counts against the per-address rate limit (1200/min), far above any
  monitor's needs.
- It does **not** check the auth service, the SMTP relay, or whether
  ResourceSpace's API key works. `configured` only means the key is set.

## The Reviewers' email

One email per Submission, from `SDFWA Media <no-reply@sdfwa.org>` to
`media-reviewers@sdfwa.org`, through the Google Workspace SMTP relay
([ADR 0006](adr/0006-reviewer-notification-by-workspace-smtp-relay.md),
#61). Relay settings and the Group's posting rule:
[host-setup.md](host-setup.md#reviewer-notification-mail).

**When it goes:**

- It is scheduled when a Submission starts (the member presses Send).
- **Complete:** at once, when every Item the page said it would send is in
  ResourceSpace.
- **Partial** ("9 of 14 sent"): at once, when the page finishes with some not
  sent; or after `REVIEWER_EMAIL_STALL_MINUTES` (30) with nothing arriving. The
  deadline slides forward with every chunk, hand-off try and Item, so a slow
  but healthy upload never trips it.
- **Nothing:** when it stalls with no Item in ResourceSpace at all. There is
  nothing to review (logged).
- **Generic notice** ("An incomplete Submission may be ready for review"): only
  if staging was damaged or edited by hand while the email waited, so the
  Submission's record is unreadable.

**At most one.** Items that arrive after a partial email are in Pending Review
without a second email. The one exception: a crash between the relay accepting
it and the service writing that down sends it once more after the restart (a
rare duplicate was preferred over a lost email).

**Retries:** a failed send is tried again 3 times, after 30 s, 2 min and 10 min.
Each failure logs `could not send the reviewer email` with the relay's error.
After the last, an audit line `{"event":"reviewer_email","outcome":"failed"}`,
and that Submission's email is given up. None of this affects the member.

**Restarts:** each pending email's state is on staging
(`<submission id>.notify.json`). At startup it is read back; a complete or
finished Submission's email goes at once, and anything else gets a fresh stall
deadline from the restart.

The email has a button to the Submission's Items in Pending Review, the Step 2
answers, and Reply-To set to the member. The link is
`https://media.sdfwa.org/pages/search.php?search=submissionid%3A<submission id>&archive=-1`,
which also works by hand. **Pending Review in ResourceSpace is always the full
list**; the email is a convenience.

Kill switch: [`REVIEWER_EMAIL_PAUSED`](#reviewer_email_paused-stop-the-reviewers-email).
If one did not arrive: [runbook](runbooks/reviewer-email-missing.md).

## Adding or removing a Reviewer

A Reviewer needs two things.

**1. A ResourceSpace account in the Media Reviewers group.**

1. Sign in to `https://media.sdfwa.org` as an admin.
2. Admin > Users. Create the user, or open the existing one.
3. Set **User group** to **Media Reviewers**, and save.

Their dash picks up the **Pending review** tile when their group changes. They
can approve (Publish), reject (Delete), edit the member-facing fields, and read
the six Submitter fields but not edit them. Don't change the group's
permissions in the admin UI: `scripts/rs-setup.sh provision` resets them to
what `scripts/rs-setup/provision.php` declares. See
[resourcespace-setup.md](resourcespace-setup.md).

**2. Membership of the `media-reviewers@sdfwa.org` Google Group**, so they get
the email. You can manage the Group in either place: admin.google.com
(Directory > Groups) or groups.google.com. Open `media-reviewers@sdfwa.org` >
Members > Add members.
Leave the Group's posting setting alone: it must keep allowing
`no-reply@sdfwa.org` to post.

**Check:** they sign in and see the Pending review tile; the next Submission's
email reaches them (ask them to check spam the first time).

**To remove a Reviewer,** do the reverse: move their ResourceSpace user to
another group (or disable it), and remove them from the Group.

## Patching

**The ResourceSpace image** runs ImageMagick, ghostscript, ffmpeg, exiftool and
libheif on every upload, including members' files once they pass the upload
service. Docker's build cache keeps whatever versions the first build
installed, so merges don't pick up security updates by themselves.

**Cadence: once a month, and as soon as possible after a published
vulnerability in ImageMagick, ghostscript, ffmpeg, exiftool or libheif.**

1. Bump `ARG PATCH_REFRESH` near the top of the root `Dockerfile` to the
   current month (for example `2026-11`) and merge. That re-runs the apt layer
   and redeploys ResourceSpace with Ubuntu's current security updates.
2. After the deploy, record the versions in the PR:
   ```sh
   ssh $HOST 'docker exec $(docker ps -q --filter label=com.docker.compose.service=resourcespace) dpkg-query -W imagemagick-6.q16 ghostscript ffmpeg libimage-exiftool-perl libheif1'
   ```
3. Upload a JPEG, a phone HEIC, a PDF and an MP4 through ResourceSpace and check
   each gets a preview.

The full note, with the ImageMagick policy, is in the
[README](../README.md#media-tools-imagemagick-policy-and-patching-cadence).
Upgrading ResourceSpace itself (the SVN revision) is in the
[README](../README.md#resourcespace-version).

**The upload image** (`upload/Dockerfile`, `node:24-alpine`) has no media
tools: it checks a file's type from its first bytes. Its runtime dependencies
are `@tus/server`, `@tus/file-store` and `nodemailer`. Keep them current with
`npm update` / `npm audit` in `upload/` on the same monthly cadence; the merge
rebuilds the image.

**Base images are not refreshed by a deploy.** Builds on the host reuse
BuildKit's cache, so `node:24-alpine` (upload) and `ubuntu:24.04`
(ResourceSpace) are served from the cache, not pulled fresh (checked
2026-10-15). To pick up a newer base, pull it on the host and then redeploy:

```sh
ssh $HOST 'docker pull node:24-alpine && docker pull ubuntu:24.04'
```

Or use a no-cache rebuild in Dokploy, if the UI offers one. Do this as part of
the monthly patch, and when a base-image vulnerability is published.

## Monitoring

**No uptime monitoring is set up yet.** Nothing alerts anyone when the service
or ResourceSpace goes down; a member or a Reviewer notices first.

When one is added, it should watch `https://media.sdfwa.org/upload/health`
every few minutes and alert on anything but **200**. That covers ResourceSpace
answering, the API key being set, and staging being mounted, writable and under
the cap. It does not cover the auth service or the mail relay. Treat
`"paused": true` as a reminder that the kill switch is on.

Other things a maintainer can check by hand:

- the backup sidecar's health (`docker ps` STATUS): [backups.md](backups.md);
- the `reviewer_email` audit lines, for emails given up;
- staging usage, from the health endpoint.

Central logs are being looked at in #80.

## Known accepted gaps

These were decided, not overlooked.

- **A rare empty Item in Pending Review (lost-create gap, #58/#81).** If
  ResourceSpace creates the Item but its answer never reaches the service (a
  timeout, or the service stops at that moment), the service does not know the
  ref, and a retry creates another Item. The first one is **empty**: no file
  and no fields, never a second copy of a photo. The service logs
  `… it may hold an empty Item from it` with the upload, the Submission and the
  time. **A Reviewer deletes the empty Item from Pending Review.** It has no
  Submission ID, so it won't show in the email's link; look for an Item with no
  title or preview near the logged time. Closing the gap would need a new
  searchable field and the `s` permission for the uploader, which would let
  that key search the whole collection; Isaac decided (2026-10-12) the risk
  does not justify that.
- **The SMTP relay trusts the server's IP** (ADR 0006). Any container on this
  host can send as an `@sdfwa.org` address. If that ever matters, change the
  relay rule to require SMTP authentication with a dedicated account. If the
  server's public IPv4 or IPv6 changes, the relay refuses mail until the new
  addresses are allowed: [host-setup.md](host-setup.md#reviewer-notification-mail).
- **Quotas are held in memory** (#23). A restart (any redeploy of the `upload`
  container) forgets who sent what today, so a member could send another day's
  worth right after one. What is on staging is counted again, and the staging
  cap still protects the disk. A Submission's room is forgotten too: Items
  already uploaded still hand over, but new ones into that Submission are
  refused, and the page starts a new Submission next time.

Related, and tracked elsewhere:

- **Logs stay on the host** and go with the container: #80.
- **No HSTS, and Traefik's `api.insecure` is on:** #79.
- A field the read-back cannot confirm is logged and the Item still counts
  as received; a Reviewer fills it in at Approval (ADR 0003).
- The `upload-service` account has two ResourceSpace permission limits
  accepted in #34: see [resourcespace-setup.md](resourcespace-setup.md#what-verify-checks).
