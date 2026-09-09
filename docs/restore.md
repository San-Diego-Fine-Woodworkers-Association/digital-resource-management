# Restore / Disaster Recovery Runbook

How to rebuild ResourceSpace from backups — a single lost DB, or the whole box.
Read [backups.md](./backups.md) first for what each artifact is.

**You need three things to fully recover:**
1. **This git repo** — the compose stack, Dockerfiles, `config.php`.
2. **The backup artifacts** — `db/*.sql.gz` and `filestore/` (from the off-site
   box's newest good snapshot, or the server's `backups` volume).
3. **The deployment secrets** — the Dokploy env vars (`SCRAMBLE_KEY`,
   `API_SCRAMBLE_KEY`, `MYSQL_ROOT_PASSWORD`, `MYSQL_READ_ONLY_PASSWORD`,
   `SIMPLESAML_ADMIN_PASSWORD_HASH`, `DOMAIN_NAME`, email vars). From your
   password manager, or `secrets-latest.env.age` if you enabled encrypted
   secret capture: `age -d -i <your-age-key> secrets-latest.env.age`.

> ⚠️ Without `SCRAMBLE_KEY` the filestore is present but unreadable by RS — the
> keys must match the data. Recover the secrets, don't regenerate them.

---

## Scenario A — restore just the database

The stack is up; you need to roll the DB back to a known-good dump.

```bash
# On the server, from a checkout of this repo (or anywhere docker is available):
scripts/restore-db.sh /path/to/resourcespace-<ts>.sql.gz
# It reads the mariadb container's own root password, prompts, then imports.

docker compose restart resourcespace
```
Then log in as admin — if the dump predates a code upgrade, RS may prompt to run
a schema upgrade; let it.

---

## Scenario B — full rebuild on a fresh box

### 1. Provision + prime the host
Bring up an Ubuntu 24.04 box and run the deployment-server priming from the
[`Digital-Services-Init`](https://github.com/San-Diego-Fine-Woodworkers-Association/Digital-Services-Init)
repo (UFW, SSH hardening, DOCKER-USER firewall, auto-updates). Register it in
Dokploy and let *Setup Server* install Docker / join the swarm.

### 2. Recreate the stack in Dokploy
Create the Compose service pointing at this repo, and **restore the environment
variables** (step 3 of the prerequisites) into the Dokploy environment for the
stack — same values as before. Deploy so the containers build, but expect an
empty DB and filestore for now.

### 3. Restore the filestore
Copy the backed-up `filestore/` into the `rs_assets` volume. With the stack
deployed (volume exists) and the resourcespace container **stopped**:

```bash
# Identify the volume (name is <stack>_rs_assets)
docker volume ls | grep rs_assets

# Load the mirror into it (run where the backup 'filestore/' is reachable):
docker run --rm \
  -v <stack>_rs_assets:/dest \
  -v /path/to/backup/filestore:/src:ro \
  alpine sh -c 'cd /src && cp -a . /dest/'

# Fix ownership (RS runs as www-data / uid 33 in the image):
docker run --rm -v <stack>_rs_assets:/dest alpine chown -R 33:33 /dest
```

### 4. Restore the database
```bash
scripts/restore-db.sh /path/to/resourcespace-<ts>.sql.gz
```

### 5. Bring it up and finish
```bash
docker compose up -d
docker compose restart resourcespace
```
- Log in as admin; run the schema upgrade if prompted.
- **Regenerate ML data** (caches were intentionally not backed up):
  ```bash
  docker compose exec resourcespace php /var/www/html/plugins/clip/scripts/generate_vectors.php
  docker compose restart clip
  docker compose exec resourcespace php /var/www/html/plugins/faces/scripts/faces_detect.php
  docker compose exec resourcespace php /var/www/html/plugins/faces/scripts/faces_tag.php
  ```
- **SAML/SSO:** the certs live under `filestore/system/` (restored in step 3) and
  the IdP metadata is in `config.php`. Confirm the `entityID`/ACS URL still match
  the new domain if it changed, then test a Google SSO login.
- Verify: HTTPS loads, a resource preview renders, search works, a login succeeds.

---

## Restoring from the off-site box

The off-site box holds `mirror/` (latest) and dated `snapshots/<ts>/`. To recover
from a specific night, use that snapshot's `db/` and `filestore/` as the source
paths above. Push them back to the (new) server first, e.g.:

```bash
# from the on-prem box (write access to the new server as an admin user):
rsync -az -e ssh /srv/backups/resourcespace/snapshots/<ts>/ admin@<new-server>:/tmp/rs-restore/
```
Then run scenarios A/B on the server against `/tmp/rs-restore/`.

---

## Test-restore checklist (run quarterly)
- [ ] `gzip -t` the latest DB dump — passes
- [ ] Restore DB + filestore onto a throwaway box
- [ ] Decrypt the secrets snapshot (or fetch from the password manager)
- [ ] Stack comes up; admin login works; a preview renders; search returns hits
- [ ] Note the wall-clock time it took (your real RTO) and any missing step here
