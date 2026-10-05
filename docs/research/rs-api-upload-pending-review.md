# Research: ResourceSpace API for uploading into Pending Review

Issue: #13 (part of map #12, Member Media Upload). Planning only; nothing here was built or run.

**Question.** On our self-hosted ResourceSpace 11.0, how does a service upload an Item through the API and leave it in Quarantine (Pending Review)?

## Sources and how they were read

- **RS source** = SVN `https://svn.resourcespace.com/svn/rs/releases/11.0` at **r29660**, the revision pinned in this repo's `Dockerfile` (`svn co -r 29660 .../releases/11.0`). Files were read at that exact revision via the peg URL `https://svn.resourcespace.com/svn/rs/!svn/bc/29660/releases/11.0/<path>`. Line numbers below are from those r29660 files.
- **RS docs** = `https://www.resourcespace.com/knowledge-base/` (API pages: `/api/`, `/api/create_resource`, `/api/upload_multipart`; permissions: `/systemadmin/user-permissions`). The KB is not versioned per release; where it matters it is cross-checked against the source.
- **Traefik docs** = `https://doc.traefik.io` (entrypoints, buffering middleware), read from the `v3.1` docs tree in the Traefik repo.
- This repo: `Dockerfile`, `config.php`, `docker-compose.yaml`.
- "UNVERIFIED" marks anything not confirmed from a primary source or by running it.

## Short answer

1. **Two API calls.** `create_resource` (with explicit `archive=-1`) returns the new resource ID. Then `upload_multipart` POSTs the file to that ID. (`update_field` / `add_resource_nodes` set metadata in between or after; see ticket #14.)
2. **Pending Review is archive state `-1`.** It is reachable only if the API user has permission `e-1` and either `c` or `d`. Otherwise `create_resource` returns a bare `false`.
3. **Signing.** `sha256(user_key . query_string)`, where the user key is `sha256(user_ref . API_SCRAMBLE_KEY)`. The file is not part of the signature.
4. **Reviewers can approve in the stock UI.** Team Centre has "View user contributed resources pending review", and the Edit page status dropdown moves an Item to Active. Reviewers need specific permissions (below).
5. **Biggest open risks:** (a) the browser-to-server hop is capped by Traefik's default `readTimeout` of 60s for the whole request body and by PHP's 100M limit, with no chunking in the API; (b) HEIC thumbnailing is unverified in this image; (c) video previews are generated synchronously inside the upload request.

## 1. API functions

Endpoint: `/api/` (`api/index.php`). All functions are `api_<name>` bindings in `include/api_bindings.php`.

### `create_resource` (`api_bindings.php` L130-202)

Signature: `create_resource($resource_type, $archive = 999, $url = "", $no_exif = false, $revert = false, $autorotate = false, $metadata = "")`.

- Returns the integer resource ID, or `false` on any failure (no error detail).
- Requires `(c or d)` and not `XU<type>` (L138). Returns `false` otherwise.
- `$archive` handling (L142): if `$archive !== 999` and `get_default_archive_state($archive) != $archive`, it returns `false`. That is, you may only request a state you hold the `e<state>` permission for.
- `$metadata` is a JSON object of `field ID -> scalar string`. Array values make the call return `false` (L185-196). It calls `update_field` per entry.
- `$url` is "upload by URL" and requires the host to be in `$api_upload_urls`. It is not needed for our flow. Our `config.php` sets `$api_upload_urls = array()` (an empty list allows nothing).
- Docs: `/knowledge-base/api/create_resource` lists the states (Pending submission -2, **Pending review -1**, Active 0, Waiting to be archived 1, Archived 2, Deleted 3) and default 999.
- Internals: `create_resource()` in `include/resource_functions.php` L563-621. The row is inserted with `archive`, `created_by = current user`, `no_file = 1`.

If `archive` is omitted (999), `create_resource()` picks the first `e<n>` permission scanning n = -2..2 (L577-585). An uploader that also had `e-2` would silently land in -2 (Pending Submission), so **always pass `archive=-1` explicitly**.

### `upload_multipart` (`api_bindings.php` L1294-1435)

Signature: `upload_multipart(int $ref, bool $no_exif, bool $revert, bool $previewonly = false, int $alternative = 0, bool $autorotate = false)`.

- Single request, `POST`, `Content-Type: multipart/form-data`, file in form field **`file`**. Otherwise 405 / 415 / 400 (L1300-1311).
- Checks `overquota()`, then `get_edit_access($ref)` (L1352), then calls `upload_file()`.
- Responses: `204` on success; `413` if `UPLOAD_ERR_INI_SIZE`; `500` for other upload errors or a failed `upload_file`; `403` for banned extensions on the alternative-file path.
- **There is no chunked or resumable variant in the API.** The "chunkSize" the RS web UI uses (`$upload_chunk_size = '50mb'`, `config.default.php` L1472) is emitted by `pages/upload_batch.php` (L1378-1380) for the browser Uppy widget and is handled by that page's own endpoint, not by `/api/`.
- Docs: `/knowledge-base/api/upload_multipart` (same shape; response examples for 500/413/400 duplicate).
- Related, not needed: `upload_file` (server-local path, restricted by `$valid_upload_paths`), `upload_file_by_url`.

### Resource type

`create_resource` needs a resource type ID. There is no auto-detection by extension in the API: the caller (our proxy) must choose photo vs video (look up with `get_resource_types`; `update_resource_type` can change it later). Which IDs exist on our instance is not recorded here (UNVERIFIED; check admin before building).

## 2. Request signing

Sources: `include/api_functions.php` (`get_api_key`, `check_api_key`), `api/index.php`; docs `/knowledge-base/api/`.

- Per-user key: `get_api_key($user_ref) = sha256($user_ref . $api_scramble_key)`. Our `config.php` sets `$api_scramble_key = getenv('API_SCRAMBLE_KEY')`. The same value therefore derives every user's API key; rotating it invalidates all keys. The RS user edit page shows each user's key. A caller can also compute it itself from the user's numeric ID plus `API_SCRAMBLE_KEY`.
- Signature: `sha256($user_key . $query)` where `$query` is the query string, e.g. `user=<username>&function=upload_multipart&ref=123&no_exif=0&revert=0`. `check_api_key` also accepts a key derived from the username instead of the ID.
- `api/index.php` strips `sign`, `authmode`, `pretty` from the string before checking. Parameter order and encoding must match exactly what was signed.
- For POST, send the full query string again as a `query` form field (`getval("query")` takes precedence over `QUERY_STRING`), plus `sign` and `user`. **The file is not signed** (docs: "IMPORTANT: this wasn't part of the signature!").
- Booleans: pass `1`/`0` (docs note this). `no_exif` and `revert` have no defaults in `upload_multipart`, so always send them.
- Other auth modes exist (`sessionkey` via `login`, and `native` = browser cookie, restricted to a whitelist). The proxy should use `userkey` mode. `$enable_remote_apis` defaults to `true` (`config.default.php` L2144) and is not overridden in our `config.php`.
- Calls are logged in as the user via `setup_user`, so the uploader must be a valid, approved RS user (not just a key).

## 3. What puts an Item in Pending Review, and what the uploader user needs

Archive states: `-2` Pending submission, **`-1` Pending review**, 0 Active, 1 Waiting to be archived, 2 Archived, 3 Deleted (`languages/en.php` `status-2`, `status-1`; docs).

`get_default_archive_state()` (`resource_functions.php` L7113-7136): a requested state is honoured only if `checkperm("e<state>")`.

Docs on permissions (`/systemadmin/user-permissions`): `c` = "Can create resources / upload files (Admin users; resources go directly into usable state)", `d` = "Can create resources / upload files (Normal users; resources go into 'pre-check' state)", `e-1` = "User contributed, awaiting team review".

Proposed minimal group for the shared uploader user (derived from the code above; **not tested**):

| Permission | Why |
|---|---|
| `d` | needed by `create_resource` (L138) and `upload_file` (`image_processing.php` L59) |
| `e-1` | lets `archive=-1` be requested and lets the user edit its own pending items, which `upload_multipart` requires via `get_edit_access` (`resource_functions.php` L5535-5560: pending items are editable by their creator) |
| field-level access | `update_field` needs `get_edit_access` plus `metadata_field_edit_access` for each field (`api_update_field` L214-250) |

Deliberately **omit** `e0` and `e-2` so the uploader cannot create Active items and the default-state scan cannot pick -2. Do not give it `c` (see above: `c` is the admin-style permission). Avoid `XU<type>` for the photo/video types.

Other config that interacts:
- `$override_status_default` (`config.default.php` L1285) is `false`; if it were set it would also affect `get_default_archive_state` when no state is passed.
- Our `config.php` sets `$upload_then_edit = true`. This affects the browser upload page flow, not API calls. Not verified further.

## 4. Visibility and Approval in the stock UI

- **Pending items are hidden from everyone else** unless they hold `v`: `search_functions.php` L853-868 appends `(r.archive<>-1 OR r.created_by = <me>)` for users without `v`. The `!userpending` special search (L1407-1414) lists `archive=-1`, but is subject to the same filter.
- **Where reviewers look:** Team Centre -> Manage resources -> "View user contributed resources pending review", shown when the user has `e-1` (`pages/team/team_resource.php`, links to `pages/search.php?search=&archive=-1`). Label string `viewuserpending`: "View user contributed resources pending review".
- **How they approve:** the resource Edit page status dropdown offers each state the user has `e<n>` for (`pages/edit.php` ~L2149); choose Active (needs `e0`). The same page, or batch edit, applies to several selected items (batch-edit behavior not verified).
- Edit access to *someone else's* pending item requires `t` (admin menu) or `ert<type>` (`get_edit_access`, `resource_functions.php` L5555-5560). So a reviewer group needs roughly: `s` (search), `v`, `e-1`, `e0`, and `t` (or `ert<type>` for photo and video) plus the usual field edit rights. **Combination not tested end to end**; confirm on the live site with a throwaway reviewer account.
- So: yes, reviewers can approve from Pending Review in the stock UI. No custom review tool is needed.

## 5. HEIC / MOV and previews

- **Processing happens inside the upload request.** `upload_file()` ends by calling `start_previews()`. With `$offline_job_queue = false` (default, `config.default.php` L3161; not overridden in our `config.php`) and no `$preview_generate_max_file_size`, previews are generated synchronously (`image_processing.php` L475, L3363-3399). For videos this means ffmpeg transcoding while the HTTP request is open (PHP `max_execution_time` is 300 per our `Dockerfile`).
- **Video:** `mov` is in the default `$ffmpeg_supported_extensions` (`config.default.php` L1505+). Our `config.php` forces an MP4 preview (`$ffmpeg_preview_force = true`, `$ffmpeg_preview_extension = 'mp4'`, libx264 baseline, `$ffmpeg_preview_seconds` default 120). ffmpeg is installed in the image (`Dockerfile`). Default preview dimensions are 700x394 (`config.default.php` L458-459).
- **HEIC:** the RS source at r29660 contains no HEIC-specific handling (no `heic` or `heif` string in `config.default.php`, `image_processing.php`, `resource_functions.php`, `search_functions.php`, `general_functions.php`, `definitions.php`). Previews therefore rely on ImageMagick 6 (`convert`) in the Ubuntu 24.04 image having a HEIC decoder. The `imagemagick-6.q16` package only *recommends* `libmagickcore-6.q16-7-extra` (packages.ubuntu.com/noble), and that package page does not list libheif. **UNVERIFIED whether HEIC thumbnails work here.** Needs a test in the built image (`convert -list format | grep -i heic`, then upload a real iPhone `.heic`).
- `banned_extensions` (`config.default.php` L1253-1278) blocks only executable and script types (php, js, sh, py, exe, css, swf and similar); jpg, heic, mov, mp4 are not banned. Extension comes from the original file name (`upload_file` L173-213), so the proxy must pass a correct file name.
- `$camera_autorotation_ext` (jpg, jpeg, tif, tiff, png) shows `autorotate=1` would not apply to HEIC even if enabled.
- Duplicates: `$file_upload_block_duplicates = false` by default; our `config.php` sets `$file_checksums = true`. Not a concern for v1 (duplicate detection is out of scope).

## 6. Server-side limits that cap upload size

From front to back:

| Layer | Limit | Source |
|---|---|---|
| Traefik entrypoint `readTimeout` | **60s default, covers reading the entire request including body** (0 disables) | Traefik docs, entrypoints `transport.respondingTimeouts.readTimeout` |
| Traefik `writeTimeout` / `idleTimeout` | 0s / 180s defaults | same |
| Traefik request body size | no limit unless the Buffering middleware sets `maxRequestBodyBytes`; our `docker-compose.yaml` labels set none | Traefik docs, buffering middleware; this repo |
| Apache | no body cap configured by our `Dockerfile` (not independently verified against Ubuntu's Apache default) | `Dockerfile` |
| PHP `upload_max_filesize` | **100M** per file | `Dockerfile` (sed on php.ini) |
| PHP `post_max_size` | **100M** per request | `Dockerfile` |
| PHP `max_execution_time` | 300s (covers inline preview generation) | `Dockerfile` |
| PHP `memory_limit` | 1G | `Dockerfile` |
| RS `$upload_max_file_size` | unset (optional, UI only) | `config.default.php` L1469 |

Consequences:
- **A single-shot upload tops out at ~100 MB**, below typical phone video sizes. Raising it is a `Dockerfile` change.
- If PHP `post_max_size` is exceeded, PHP drops `$_POST` and `$_FILES`. By reading `api/index.php`, `query` would then be empty and the request would fail signature check with `401 Invalid signature` rather than a `413` (**inference from the code, not tested**). Treat a 401 on large files as a size problem, not an auth one.
- **If the proxy is on the same Docker network and talks to RS directly** (not via `media.sdfwa.org`), the Traefik limits apply only to the browser-to-proxy hop. Whether RS accepts requests under a different Host header (`$baseurl` handling in `config.php`, which also forces HTTPS via `X-Forwarded-Proto`) is **UNVERIFIED**.
- The Traefik `readTimeout` is a static (entrypoint) setting, not settable with the router labels in our compose file. It lives in the Dokploy-managed Traefik config, which is outside this repo.
- Because RS has no chunked API, any resumable or chunked behaviour for flaky mobile links must be done by our proxy (assemble chunks to disk, then POST once to `upload_multipart`). That ties into the "Not yet specified" failure-handling item on map #12.

## 7. Open risks and things to verify before build

1. HEIC preview support in the `ubuntu:24.04` ImageMagick 6 build (see section 5).
2. End-to-end permission set for uploader and reviewer groups (sections 3 and 4) on the real instance; in particular that `d` + `e-1` is sufficient and a reviewer with `t`, `v`, `e-1`, `e0` can see and activate another user's pending Item.
3. Resource type IDs for photo/video and how the proxy maps file extension to type.
4. 100 MB PHP cap vs. real phone videos; decide limits (ticket #18) and whether to raise PHP limits or chunk in the proxy.
5. Traefik 60s `readTimeout` for browser-to-proxy uploads on slow mobile data; confirm the effective Dokploy Traefik configuration.
6. Synchronous ffmpeg preview in the request (300s PHP cap); consider `$offline_job_queue` (needs a cron'd `pages/tools/offline_jobs.php`, per the comment in `config.default.php` ~L3155-3160) if videos time out.
7. Error reporting is poor on some paths (`create_resource` returns bare `false`; a too-big POST likely shows as 401). The proxy needs its own validation and logging.
8. Which RS username/key the proxy uses and where `API_SCRAMBLE_KEY` is exposed (it is already an env var on RS in `docker-compose.yaml`). Whether to copy the key from the RS UI or derive it is a build-time decision.
