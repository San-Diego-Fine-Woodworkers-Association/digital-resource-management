# Research: Reviewer notification options in ResourceSpace

Resolves issue #29 (part of map #12). Facts and open risks only; nothing here is built.

**Question.** How can Reviewers be told when new Items arrive in Quarantine (Pending Review, archive state `-1`)?

**Sources.** Every claim cites one of:

- **Source**: ResourceSpace 11.0 at SVN r29660, the revision pinned in `Dockerfile` on `origin/main` (`svn co -q -r 29660 .../releases/11.0`). Paths are relative to `releases/11.0/` and were read at `https://svn.resourcespace.com/svn/rs/!svn/bc/29660/releases/11.0/<path>`.
- **Docs**: the ResourceSpace knowledge base, `https://www.resourcespace.com/knowledge-base/...`. The knowledge base is not versioned by release. Where a page says "Version 10.3+" it still applies to 11.0.
- **Repo**: this repo at `origin/main` (`config.php`, `Dockerfile`, `entrypoint.sh`, `cronjob`, `docker-compose.yaml`).

Anything not confirmed from those is marked **UNVERIFIED**.

## Short answer

1. ResourceSpace has **no immediate notification** when an Item enters Pending Review, and by design never will. The docs say so: immediate notifications are not enabled, to avoid one email per Item during a bulk upload (Docs `user/actions`, FAQ "Why can't we just use emails or system notifications?").
2. What it has instead is **My Actions**, which covers two things:
   - An **in-app, live list** of every Item the Reviewer can edit that sits in a chosen workflow state, with a count badge in the user menu. This works with no cron and no email. It is the dependable option.
   - An **opt-in email digest** of "new actions", sent per user by the cron job. It is a table of Items, one row per Item, with no grouping by Submission. Items created through the API are **likely to be missed by it** (see "Open risks", the log-row finding).
3. Notification **per Submission** is not available. Everything is per Item. The Submission ID can only be used as a search filter.
4. Any "one email per finished Submission" has to live **outside ResourceSpace** (the proxy), because RS cannot know a Submission is finished.

## 1. In-app: My Actions (works today, no setup beyond permissions)

- `$actions_enable = true` by default (Source `include/config.default.php:2641`). Users also qualify if they hold one of `$actions_permissions = array("a","t","R","u","e0")` (config.default.php, "Default action settings" block; logic in `include/user_functions.php` around line 139 where `$actions_on` is set). A Reviewer with `e0` qualifies.
- Which Items appear is state-based, not event-based. `get_user_actions()` (Source `include/action_functions.php:17`) runs a live search over `$actions_notify_states` via `get_editable_resource_sql()`, so it lists whatever the user can edit in those states right now. An Item leaves the list when it is approved or moved. Docs `user/actions` ("Why has a resource disappeared...") confirms this.
- **Default states.** If the user has not set `actions_notify_states`, `get_default_notify_states()` (Source `include/user_functions.php:3390`) returns:
  - `-1` (Pending Review) for users with both `e-1` and `e0`;
  - `-2` (Pending Submission) only for users with `e-2` and `e-1` and `d`.

  The Reviewer group planned in #24 (`s`, `v`, `e-1`, `e0`, `t`) therefore gets Pending Review actions **by default**, with no per-user setting. `setup_user()` applies this (`include/user_functions.php`, "Set default workflow states to show actions for"). A user can override the states in Preferences, and group config overrides can set `$actions_notify_states` for a group (Docs `systemadmin/user-group-config-overrides`; Source `setup_user()` applies the group's `config_options` before this block).
- **Display.** A badge with the action count shows in the user menu next to messages (Source `pages/ajax/message.php:101` calls `get_user_actions(true)`; Docs `user/actions`). The list page is `pages/user/user_actions.php`. The page also offers "View resources to review as a result set" and "Add all editable resources to collection" (Docs `user/actions`).
- **What a row shows.** Date, the creating user, the resource ID, a description (the Title field via `$view_title_field`) and the type (Source `include/action_functions.php:17-95`; Docs `user/actions`). The "user" is `resource.created_by`, which for our Items is the **shared uploader user**, not the Submitter. The Submitter and Submission ID are not shown in the list. The Reviewer would need to open the Item or use the "view as result set" search.
- **Does it need Reviewers to be edit-capable?** Yes. The list only includes Items the user can edit (`get_editable_resource_sql()`, and `get_edit_access()` in the email path). `e-1` is the permission that matters; #24 already requires it.
- **Cron and the offline job queue.** Neither is needed for the in-app list. It is a live query.

## 2. Email: the "new actions" digest (opt-in, cron-driven)

How it works (Source `batch/cron_jobs/015_action_notifications.php`, `include/action_functions.php`):

1. The cron script (`pages/tools/cron_copy_hitcount.php` includes `batch/cron.php`, which runs every `batch/cron_jobs/NNN_*.php`) calls job 015.
2. Job 015 **does nothing unless `$new_action_email_interval` is a positive integer** (config.default.php:2668, default `0`). Valid range 1 to 168 hours (`ACTIONS_EMAIL_MAX_AGE = 168`, `include/definitions.php:816`).
3. It skips if less than the interval has passed since the sysvar `last_action_notification_emails`. It then looks back over the time since the last run (capped at 7 days) and calls `get_user_actions_recent()`.
4. Recipients are users who opted in: `get_users_by_preference("user_pref_new_action_emails", "1")` (Source `include/user_functions.php:3370`). That function reads **only the `user_preferences` table** (`parameter = ? AND value = ?`, user must be `approved=1`). Consequences:
   - Each Reviewer must switch it on themselves in Preferences > Email ("Email me if new actions are created"), which only appears when `$actions_on && $new_action_email_interval > 0` and the user has an email address (Source `pages/user/user_preferences.php:193-195`, shown inside the `$useremail != ""` block).
   - A group-level config override of `user_pref_new_action_emails` does **not** feed this query (it never reads group config), so an administrator cannot opt a whole group in. UNVERIFIED at runtime, but the SQL is unambiguous.
   - `$user_pref_new_action_emails = false` is the global default (config.default.php:2504).
5. For each opted-in user, `actions_filter_by_user()` (Source `include/action_functions.php:208`) keeps only Items that:
   - are in that user's notify states (default `-1` for `e-1`+`e0`);
   - are of a type the user has not hidden;
   - the user can edit;
   - were **not** changed by that same user (`$typeaction["user"] != $actionuser`, line 241).
6. One email per user per run, an HTML table with one row per Item: date, ID, user, title (trimmed to 200 characters), type and Edit/View links. It is sent with `send_user_notification([...], ..., true)`, which forces email (Source `message_functions.php:912`, third argument `$forcemail`). Docs `user/actions` ("New action emails") confirms the intent: "send an email summary of these new actions".
7. Frequency, per Docs `user/actions` and `systemadmin/cron`: the cron script "must be run more frequently than the interval". The cron page recommends every 15 minutes if `$new_action_email_interval` is enabled.

So this is a **digest**, not a per-Item or per-Submission email. A 50-Item Submission would be 50 rows in one email (or split across two digests if it straddles a run).

### Subscribing to a search or collection

No such feature found. A search of `pages/` and `include/` for subscribe, saved-search alerts and feeds found only collection sharing by email (`pages/collection_email.php`) and unrelated "feed" hits (`pages/collection_feedback.php`, autocomplete). There is no "email me when a saved search gets new results". The nearest thing is a **dash tile** for a search (Docs `dash-tiles`), which shows in-app on the home page only. Dash tile counts were not examined in detail: **UNVERIFIED** whether a tile can be pinned to archive state `-1`.

Other notifications that look related but are not:

- `$resource_contact_link` (config.default.php:2348) adds a "contact admin" box on the view page that messages users with `t` and `e0`. It is user-initiated, not triggered by upload (Source `pages/view.php:268`, `pages/ajax/contactadmin.php`).
- `$user_pref_resource_notifications` only affects resource-file replacement and `$send_collection_to_admin` notices. The docs state that "From version 10 the legacy resource submission notifications have been replaced by actions" (Docs `systemadmin/notifications`).
- The daily unread-messages digest (`batch/cron_jobs/007_message_send_unread_emails.php`, `message_send_unread_emails()`) only mails messages that already exist. Nothing creates a message when an Item enters Pending Review (see section 4), so it has nothing to say about new Items.

## 3. Do API-created Items trigger anything?

**No immediate notification, in-app or email.** Facts from source:

- `api_create_resource()` (Source `include/api_bindings.php:130`) calls `create_resource()`. That function inserts the row, logs `LOG_CODE_CREATED` (`'c'`) and bumps a daily stat (`include/resource_functions.php:~613`). It sends no message or email.
- `update_archive_status()` (Source `include/resource_functions.php:6411`) logs a status change and ends with a comment "Send notifications" followed only by a `debug()` call. It sends nothing either.
- The **only** message sent about uploads in the job handlers goes to the uploading user on **failure** (`include/job_handlers/upload_processing.php:103`, `update_resource.php:28`). For us that is the shared uploader account, not a Reviewer.

**In-app My Actions works for API-created Items**, because it is a live query over state `-1` (section 1). They show as long as the Reviewer can edit them.

**The email digest probably does NOT pick them up** (this is the main open risk). `get_user_actions_recent()` (Source `include/action_functions.php:131-150`) finds candidates with:

```sql
FROM resource_log rl
LEFT JOIN resource_log rl2 ON (rl.resource=rl2.resource AND rl.ref<rl2.ref)
...
WHERE rl2.ref IS NULL
  AND rl.type IN ('s','c')          -- LOG_CODE_STATUS_CHANGED, LOG_CODE_CREATED
  AND TIMESTAMPDIFF(MINUTE,rl.date,NOW()) < ?
```

`rl2.ref IS NULL` means "this is the **latest log row of any type** for the resource". The resource qualifies only if that last row is a create (`'c'`) or status change (`'s'`). Our flow writes more log rows after the create:

- each metadata write via `update_field()` logs `LOG_CODE_EDITED` (`'e'`) (`include/resource_functions.php:2812`);
- the file upload logs `'u'` (`include/image_processing.php:508`, only when `$after_upload_processing` is false; the `no_file=0` update at `:319` is a direct SQL write, so no `FIL` row is confirmed);
- preview generation logs `LOG_CODE_TRANSFORMED` (`'t'`) (`include/image_processing.php:1202`, `:4122`).

So after `create_resource` with explicit `archive=-1` (ticket #13) followed by metadata and the file POST, the latest row is very likely `e`, `u` or `t`, and the Item is filtered out of the digest. The stock web flow avoids this because the final step there is an explicit status change (`'s'`). **UNVERIFIED at runtime** (needs a test upload and a look at `resource_log` plus a forced cron run). The reading above is from source only.

A fact that follows from the query: an Item whose latest log row is a status change would be picked up, so a final status write (a single `update_archive_status`-style change as the last step) would satisfy it. Not recommended here, only noted as what the source rewards. Whether the API can perform a no-op or `-1` to `-1` status change that logs `'s'` is **UNVERIFIED**.

Also the digest excludes changes made by the recipient (`!= $actionuser`). The uploader user is not a Reviewer, so this does not hide our Items.

## 4. Per Submission or per Item?

**Per Item only.**

- Actions and digest rows are one per resource, with no grouping hook, and the displayed "description" is the Title field only (Source `include/action_functions.php:36-47`, `:136-142`).
- The Submission ID is an ordinary metadata field. It can be used to **find** a Submission's Items (search by that field, or "view resources to review as a result set"), which is the Reviewer's way to Approve them together. It cannot drive notification.
- `$actions_resource_types_hide` / per-user `actions_resource_types_hide` filter by resource type, not by field value (Source `include/action_functions.php:208-256`).
- The plugin hooks `addtoactions` and `user_actions_recent` (Source `include/action_functions.php:~58`, `:~167`) allow a plugin to add custom action rows or sources. Using them would be custom plugin code. Not investigated further.

## 5. Dependencies: cron, offline job queue, email transport

**Cron.** In this repo:

- `Dockerfile` does `ADD cronjob /etc/cron.daily/resourcespace`, and `entrypoint.sh` runs `service cron start`, `chmod +x /etc/cron.daily/*`, then Apache. The `cronjob` script runs `php cron_copy_hitcount.php` as `www-data`, with the container environment imported from `/proc/1/environ`.
- So the RS cron runs **at most once a day** (Debian's `cron.daily` slot; the exact time is **UNVERIFIED**; it is typically around 06:25 container time, and whether the cron daemon runs `cron.daily` without anacron in this image was not checked).
- With `$new_action_email_interval` set, a daily cron yields a **once-a-day digest** covering the elapsed window (about 24 hours plus one minute). The docs recommend running cron every 15 minutes for hourly-style digests (Docs `systemadmin/cron`), which would need a different cron entry than `cron.daily`.
- `$cron_job_time_limit = 1800` (config.default.php:1313) caps the cron run. Process lock `cron` prevents overlap (Source `batch/cron.php`).

**Offline job queue.** Not involved in notifications. Job 015 runs inline in cron. The queue is used for upload processing, preview creation and similar (Source `include/job_handlers/`). Docs page `systemadmin/offline_job_queues` exists; it was not needed.

**Email transport.** Not configured in this repo, so emails may not leave the container (**UNVERIFIED**; the points below are facts from the repo and source):

- `$use_phpmailer = false` and `$smtp_*` are blank (Source config.default.php:1957, 2215-2220; repo `config.php` does not set them). `send_mail()` therefore falls through to PHP `mail()` (Source `include/general_functions.php:1161`).
- `Dockerfile` installs `postfix` (line 17), but `entrypoint.sh` starts only `cron` and Apache, and no Postfix config (relay host, `mailname`) is in the repo. Whether `mail()` can deliver at all, and whether outbound mail from the host passes SPF/DKIM for `EMAIL_FROM`'s domain, is unknown.
- Reviewers must have an email address on their RS user record, otherwise the digest is skipped for them (`filter_var(... FILTER_VALIDATE_EMAIL)`, job 015) and the preference is hidden (`user_preferences.php:185`).

## 6. What `email_notify` and `email_from` in `config.php` imply

Repo `config.php:31-32`: `$email_notify = getenv('EMAIL_NOTIFY'); $email_from = getenv('EMAIL_FROM');`, both passed through `docker-compose.yaml` (lines 17-18).

- **`$email_from`**: the From address of all system emails, including the action digest. It matters for deliverability only. (Docs `systemadmin/notifications`: "To change the email address that system emails are sent from, navigate to Admin > System > System configuration".)
- **`$email_notify`**: **no effect on Pending Review notification.** The docs say: "The 'Email notify' address is no longer used. This has been replaced by `$email_notify_usergroups`" (Docs `systemadmin/notifications`). The config comment agrees: "deprecated as system notifications are now sent to the appropriate users based on permissions and user preferences" (config.default.php:87-88). In source it is still referenced for resource-request emails and comment flags (`include/request_functions.php:655-664`, `include/comment_functions.php:70`) and BCC when `$always_email_copy_admin` is true (`include/general_functions.php:995`). None of those paths relates to new Items. **UNVERIFIED** that nothing in `plugins/` uses it (plugins were not searched).
- **`$email_notify_usergroups`** (config.default.php:88, default empty array) takes precedence for the "notify users by permission" lookups (Source `include/user_functions.php:2476-2489`). It is relevant to request and system notices, not to the action digest, which goes to opted-in users only.
- **DB override risk.** `email_from` and `email_notify` are both editable on the System Configuration page (Source `pages/admin/admin_system_config.php:22-23`). Values saved there are stored in the database and can override `config.php` (see the project memory note about DB plugin config overriding `config.php`). `$new_action_email_interval` does **not** appear on that page (searched `pages/` and `include/`: it is only referenced in `config.default.php`, `user_preferences.php`, `action_functions.php` and job 015), so it has to be set in `config.php` or via a group config override. A group override cannot reach the cron job, which has no user context, so `config.php` is the realistic place. UNVERIFIED: whether the System Configuration page offers a generic config-options editor for it.

## 7. Options outside ResourceSpace (facts only)

These are the places where a notification can be tied to a Submission, which RS cannot do:

- **The proxy knows when a Submission is finished** (all Items accepted, or the confirmation screen is reached; see #17). It could send one email per Submission (counts, Submitter, Submission ID, a link to RS). Facts: the proxy holds the RS API credential and the Submitter's session, and #17 says it has no database, so it has no persistent state for retries or deduplication. It needs its own transport (SMTP or an email API) and a recipient list. RS user emails are readable through the RS API only by a user with the right permissions. **UNVERIFIED** which API function and permission, since `get_users` is admin-oriented.
- **A link to a pre-filtered RS search.** Because the Submission ID is a metadata field, an email could link to an RS search by that field so a Reviewer lands on exactly that Submission. The exact search URL syntax for a field value was not verified.
- **RS API polling by an external job** (a cron or the proxy) could list resources in archive `-1` and send its own digest. Not examined further. It would bypass the log-row issue in section 3 and would need the same transport.
- **Plugins.** The `addtoactions` and `user_actions_recent` hooks, or a custom plugin using other hooks such as `resourcecreate` (called in `create_resource()`), could add rules in RS. This is custom PHP code on a self-hosted install. Not investigated.

## Open risks

1. **The email digest likely misses API-created Items** because of the "latest log row" condition (section 3). UNVERIFIED at runtime. The in-app list is unaffected.
2. **Mail may not leave the container**: Postfix is installed but never started, with no relay config (section 5). UNVERIFIED.
3. **Daily granularity**: `cron.daily` means at best a once-a-day digest; the docs recommend 15-minute cron for the interval option. Whether `cron.daily` actually fires in this image is UNVERIFIED.
4. **Opt-in is per Reviewer**: each Reviewer must set the email preference themselves, and a Reviewer without an email address on their RS account gets nothing (section 2).
5. **Rows show the uploader user, not the Submitter**, and carry no Submission ID (sections 1 and 4). A digest will not tell Reviewers who submitted or which Items belong together.
6. **Admin edits to `email_from` in System Configuration** can silently override `config.php` (section 6).
7. **Stale `Dockerfile` claims**: this repo's older worktrees carry an older Dockerfile. The pinned revision r29660 was confirmed from `origin/main` only.

## Source index

- Source: `include/action_functions.php` (get_user_actions, get_editable_resource_sql, get_user_actions_recent, actions_filter_by_user), `batch/cron.php`, `batch/cron_jobs/015_action_notifications.php`, `batch/cron_jobs/007_message_send_unread_emails.php`, `pages/tools/cron_copy_hitcount.php`, `include/config.default.php` (lines 86-88, 1313, 1957, 2215-2220, 2348, 2492-2511, 2636-2668), `include/user_functions.php` (lines 139, 2476-2489, 3370, 3390), `include/definitions.php:816`, `include/resource_functions.php` (create_resource, resource_log, update_field, put_resource_data, update_archive_status), `include/image_processing.php` (lines 508, 1202, 4122), `include/api_bindings.php:130`, `include/message_functions.php` (send_user_notification, message_send_unread_emails), `pages/user/user_preferences.php` (lines 185-196), `pages/admin/admin_system_config.php:22-23`, `include/general_functions.php` (send_mail), `include/job_handlers/upload_processing.php:103`.
- Docs: `https://www.resourcespace.com/knowledge-base/user/actions`, `.../systemadmin/notifications`, `.../systemadmin/cron`, `.../systemadmin/user-group-config-overrides`, `.../dash-tiles`.
- Repo (`origin/main`): `Dockerfile`, `entrypoint.sh`, `cronjob`, `config.php`, `docker-compose.yaml`.
- Related tickets: #13 (API upload into Pending Review), #24 (uploader user and Reviewer group), #17 (proxy shape), #12 (map).
