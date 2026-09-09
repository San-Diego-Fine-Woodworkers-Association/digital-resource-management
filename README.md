# resourcespace/docker
The official Docker image for ResourceSpace. Full build instructions can be found on our [Knowledge Base](https://www.resourcespace.com/knowledge-base/systemadmin/install_docker).

# Installation notes
* Before building the Docker image, change the db.env file replacing the default "change-me" passwords to secure values.
* When setting up ResourceSpace ensure you enter "mariadb" as the MySQL server instead of "localhost" and leave the "MySQL binary path" empty.

# ResourceSpace version
This deployment runs ResourceSpace **11.0**, pinned to SVN revision `29660` (`releases/11.0 -r 29660`) in the `Dockerfile`. The `clip` and `faces` service images export their scripts at the same revision to stay in lockstep with core — bump all three together when upgrading. After upgrading from a previous version, **back up the MariaDB database first**, then log in as admin — ResourceSpace will prompt to run the 11.0 schema upgrade.

# Backups & recovery
A `backup` sidecar (see `backup/` and the `backup` service in `docker-compose.yaml`) stages nightly, consistent backups onto a `backups` volume: a `--single-transaction` MariaDB dump, an incremental mirror of the `rs_assets` filestore, and — optionally — an age-encrypted snapshot of the deployment secrets. An off-site box then **pulls** that volume over read-only, command-locked rsync/SSH, keeping dated snapshots (3-2-1). The `clip_cache`/`faces_models` volumes are intentionally skipped (regenerable).

- **[docs/backups.md](docs/backups.md)** — what's covered, the sidecar, config vars, day-to-day operation.
- **[docs/restore.md](docs/restore.md)** — disaster-recovery runbook (single DB, or full rebuild) + quarterly test-restore checklist.
- **[docs/onprem-pull-setup.md](docs/onprem-pull-setup.md)** — set up the off-site/on-prem pull box (restricted account, encrypted-at-rest, scheduling).
- Helper scripts in `scripts/`: `restore-db.sh`, `setup-onprem-pull.sh` (server), `onprem-pull.sh` (off-site box).

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
