# resourcespace/docker
The official Docker image for ResourceSpace. Full build instructions can be found on our [Knowledge Base](https://www.resourcespace.com/knowledge-base/systemadmin/install_docker).

# Installation notes
* Before building the Docker image, change the db.env file replacing the default "change-me" passwords to secure values.
* When setting up ResourceSpace ensure you enter "mariadb" as the MySQL server instead of "localhost" and leave the "MySQL binary path" empty.

# ResourceSpace version
This deployment runs ResourceSpace **11.0**, pinned to SVN revision `29660` (`releases/11.0 -r 29660`) in the `Dockerfile`. The `clip` and `faces` service images export their scripts at the same revision to stay in lockstep with core — bump all three together when upgrading. After upgrading from a previous version, **back up the MariaDB database first**, then log in as admin — ResourceSpace will prompt to run the 11.0 schema upgrade.

# Deployments
**Deployments are handled by Dokploy: a merge to `main` deploys.**

Dokploy deploys via Docker compose. In practice:
* Compose recreates only the services whose definition or image changed.
* **ResourceSpace restarts only when its own inputs change**.
* A merge starts any new or changed service immediately. If a change needs something outside this repo (a new secret in Dokploy's Environment tab, a host directory or mounted volume), set that up **before** merging.
* To roll back, merge a revert of the offending commit; the merge redeploys.

# Upload limits
PHP accepts uploads up to **1 GB per file** (`upload_max_filesize = 1G`, `post_max_size = 1100M`), set by the drop-in `php/uploads.ini`, which the `Dockerfile` copies into both the Apache and CLI `conf.d` directories. Apache's `LimitRequestBody` is raised to match, because Apache 2.4.54 and later reject request bodies over 1 GiB by default, before PHP sees them. `max_execution_time` stays at 300 s. The limits were decided in #18.

# Media tools: ImageMagick policy and patching cadence
ResourceSpace runs ImageMagick, ghostscript, ffmpeg, exiftool and libheif on every upload, and its container holds the database root credentials and scramble keys. `imagemagick/policy.xml` replaces Ubuntu's default ImageMagick 6 policy (`/etc/ImageMagick-6/policy.xml`). It is deliberately **permissive about formats** ([ADR 0005](docs/adr/0005-permissive-imagemagick-policy.md)): a short deny-list (the MVG and MSL scripting coders, URL/HTTP/HTTPS/FTP/FILE/EPHEMERAL fetchers, `@file` indirect reads and `|` pipe filenames) plus generous resource caps. Check what is in force on the server with `docker exec $(docker ps -q --filter label=com.docker.compose.service=resourcespace) identify -list policy`.

Side effect: ImageMagick 6's built-in SVG renderer works by converting to MVG, so with MVG denied, **SVG files get no preview**. They still upload and download normally.

**Patching cadence (standing maintenance item).** The member path is narrowed by the upload proxy, but past that we rely on these tools being patched. Docker's build cache keeps whatever versions the first build installed, so a merge does **not** pick up security updates on its own. Once a month, and as soon as possible after a published ImageMagick, ghostscript, ffmpeg, exiftool or libheif vulnerability:
1. Bump `ARG PATCH_REFRESH` near the top of the `Dockerfile` to the current month (e.g. `2026-11`) and merge. That forces the apt layer to re-run, and the merge redeploys ResourceSpace with Ubuntu's current security updates.
2. After the deploy, record the versions in the PR or the deploy notes:
   ```
   docker exec $(docker ps -q --filter label=com.docker.compose.service=resourcespace) dpkg-query -W imagemagick-6.q16 ghostscript ffmpeg libimage-exiftool-perl libheif1
   ```
3. Upload a JPEG, a HEIC from a phone, a PDF and an MP4 through ResourceSpace and check that each one gets a preview.

Moving off Ubuntu 24.04 (to a newer LTS, or to ImageMagick 7) is a separate upgrade. Re-test `imagemagick/policy.xml` when that happens, because the policy path and the coder names may change.

# ResourceSpace setup (fields, groups, users)
The fields, user groups, user and dash tile that the Member Media Upload flow needs live in the database. `scripts/rs-setup.sh provision` recreates them on any host, and `scripts/rs-setup.sh verify` runs a live permission test against them. See **[docs/resourcespace-setup.md](docs/resourcespace-setup.md)**.

# Member Media Upload service (`upload/`)
The `upload` service serves the member upload page at `https://${DOMAIN_NAME}/upload` (Traefik routes only `/upload` and below to it; ResourceSpace keeps every other path). It checks the visitor's SDFWA sign-in with `auth.sdfwa.org`, and has a kill switch and a health endpoint at `/upload/health`. Design: [ADR 0001](docs/adr/0001-upload-proxy-with-tus-chunking.md), [ADR 0004](docs/adr/0004-isolated-staging-volume.md), issue #33.

**Operating it: [docs/upload-service.md](docs/upload-service.md).** Every environment variable with its default, the kill switches (`UPLOADS_PAUSED`, `REVIEWER_EMAIL_PAUSED`), limits and quotas, the staging volume and its sweep, the audit log, the health endpoint, the Reviewers' email, adding a Reviewer, patching, monitoring and the known accepted gaps.

Runbooks:
* [Staging is full](docs/runbooks/staging-full.md)
* [ResourceSpace is down](docs/runbooks/resourcespace-down.md)
* [The Reviewers' email did not arrive](docs/runbooks/reviewer-email-missing.md)

The two settings a deploy needs in Dokploy: `UPLOAD_STAGING_PATH` (**required**, no default; the whole compose deploy fails until it is set) and the secret `RS_UPLOADER_API_KEY` (without it the deploy succeeds but uploads are refused). Everything else defaults to the production value. One-time host setup (the staging volume and the SMTP relay): [docs/host-setup.md](docs/host-setup.md).

A member's photo goes up in 5 MB tus chunks to the staging volume. The service then creates the Item in ResourceSpace in Pending Review (archive -1) as `upload-service`, uploads the file under a synthesized name (`<date>_<title-slug>_<submission code>-001.<ext>`), writes the member's answers and the six Submitter fields from the verified session, reads them back, and deletes the staged file. A small `<upload id>.item.json` record stays in staging so a retry reuses the same Item (#53).

Develop in `upload/`: `npm ci`, then `npm run typecheck`, `npm test`, `npm run build`. The `Upload service checks` workflow runs the same on every pull request and builds the image.

Accessibility checks (#62): `npm run test:a11y` builds the page and runs axe and the rest of the accessibility target over every screen and state in a real Chromium, with the service faked (`upload/a11y/`). The first time, install the browser with `npx playwright install chromium` (add `--with-deps` on a fresh Linux machine), or point `PLAYWRIGHT_CHROMIUM_EXECUTABLE` at a Chromium you already have. `npx playwright test -g "Step 2"` runs some of them. The workflow runs them on every pull request. What they cover, and what still needs a person with a phone and a screen reader: [docs/accessibility.md](docs/accessibility.md).

# Backups & recovery
A `backup` sidecar (see `backup/` and the `backup` service in `docker-compose.yaml`) stages nightly, consistent backups onto a `backups` volume: a `--single-transaction` MariaDB dump, an incremental mirror of the `rs_assets` filestore, and — optionally — an age-encrypted snapshot of the deployment secrets. The sidecar then **pushes** that to a Hetzner Storage Box (copy 2), and an off-site/on-prem box **pulls** from the Storage Box over a read-only rsync/SSH sub-account, keeping dated snapshots (copy 3, 3-2-1). The `clip_cache`/`faces_models` volumes are intentionally skipped (regenerable).

- **[docs/backups.md](docs/backups.md)** — what's covered, the sidecar, config vars, day-to-day operation.
- **[docs/restore.md](docs/restore.md)** — disaster-recovery runbook (single DB, or full rebuild) + quarterly test-restore checklist.
- **[docs/storagebox-setup.md](docs/storagebox-setup.md)** — provision the Storage Box push/pull sub-accounts and Snapshots.
- **[docs/onprem-pull-setup.md](docs/onprem-pull-setup.md)** — set up the off-site/on-prem pull box against the Storage Box (encrypted-at-rest, scheduling).
- Helper scripts in `scripts/`: `restore-db.sh`, `onprem-pull.sh` (off-site box, now points at the Storage Box), `setup-onprem-pull.sh` (legacy direct-to-server pull — see storagebox-setup.md).

> A full restore also needs the Dokploy environment secrets (`SCRAMBLE_KEY`, DB passwords, SAML admin hash) — without `SCRAMBLE_KEY` the filestore can't be read. Capture them via `BACKUP_SECRETS_AGE_RECIPIENT` or keep them in a password manager. See `docs/backups.md`.

# CLIP AI Smart Search
The [CLIP AI Smart Search](https://www.resourcespace.com/knowledge-base/plugins/clip-ai-smart-search) plugin is enabled in `config.php`. Its CPU-only inference service runs as a separate `clip` container (see `clip/Dockerfile` and the `clip` service in `docker-compose.yaml`), reachable from ResourceSpace at `http://clip:8000` via `CLIP_SERVICE_URL`. The service connects to the `mariadb` database using the root credentials to read/write the `resource_clip_vector` table.

After deploying, generate vectors for existing resources once, then restart the clip service so it reloads the FAISS index:
```
docker compose exec resourcespace php /var/www/html/plugins/clip/scripts/generate_vectors.php
docker compose restart clip
```
New uploads are vectorised automatically.

# AI Faces (InsightFace)
The [AI Faces](https://www.resourcespace.com/knowledge-base/plugins/faces) plugin is enabled in `config.php`. Its CPU-only inference service runs as a separate `faces` container (see `faces/Dockerfile` and the `faces` service in `docker-compose.yaml`), reachable from ResourceSpace at `http://faces:8001` via `FACES_SERVICE_URL`. It connects to `mariadb` with the root credentials.

The default InsightFace `buffalo_l` model is used under its **free non-commercial allowance** — SDFWA is a non-profit. The model downloads automatically on first run and is cached in the `faces_models` volume.

## How face tagging works

The plugin separates **detection** (finding faces in images) from **identification** (putting a name to a face). Names are stored in a metadata field you create, and `$faces_tag_field` tells the plugin which field that is.

### 1. Create the "person names" field
In ResourceSpace, go to **Admin → System → Manage metadata fields → Create new field** and create a field of type **Dynamic Keywords List** (e.g. named "Named people"). This is the field that will hold one keyword per person. A Dynamic Keywords List lets the list of names grow over time as you add people.

### 2. Point `$faces_tag_field` at that field's ref
Each metadata field has a numeric **ref** (its ID). Find it in the field list — it's the `ref=` value in the edit URL (`.../pages/admin/admin_field_edit.php?ref=NN`), also shown in the field listing. Set that number in `config.php`:
```php
$faces_tag_field = NN;   // ref of your "Named people" Dynamic Keywords List field
```
The default in the plugin is `29`, which almost certainly is **not** your field — set it explicitly or detection-on-upload will write to the wrong (or a non-existent) field.

### 3. Detect faces
Run detection so the service finds faces and generates a vector for each. Detected faces then appear as clickable boxes on the resource view page:
```
docker compose exec resourcespace php /var/www/html/plugins/faces/scripts/faces_detect.php
```
New uploads are detected automatically (`$faces_detect_on_upload = true`).

### 4. Name the people (one-time, manual)
On a resource's view page, click each detected face and assign a person from your **Named people** field. This is what teaches the system who is who — the assigned name is linked to that face's vector. You only need to do this for a handful of clear examples per person.

### 5. Auto-tag the rest
`faces_tag.php` compares every detected (but unnamed) face against the named ones and applies the matching name when the similarity clears the threshold. Run it for existing resources after naming examples:
```
docker compose exec resourcespace php /var/www/html/plugins/faces/scripts/faces_tag.php
```
New uploads are auto-tagged automatically (`$faces_tag_on_upload = true`).

### Tuning thresholds (in `config.php` / plugin settings)
- `$faces_confidence_threshold` (default `0.7`) — minimum confidence for a detected region to count as a face. Raise it to drop false detections (e.g. patterns mistaken for faces).
- `$faces_match_threshold` (default `0.3`) — similarity required to consider two faces the *same person* when searching/comparing.
- `$faces_tag_threshold` (default `0.5`) — similarity required before **auto-tagging** applies a name. Raise it to be more conservative (fewer wrong names); lower it to tag more aggressively.
