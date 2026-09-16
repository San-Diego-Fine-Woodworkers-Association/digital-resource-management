# Backups

How the ResourceSpace stack is backed up, what's covered, and how to operate it.

The design follows the **3-2-1 rule**: the server stages backups locally (copy 1),
a Hetzner Storage Box holds an off-site copy the sidecar pushes to (copy 2),
and an on-prem box pulls from *that* Storage Box into dated snapshots (copy 3,
history). The on-prem leg is **pull-based** — it reaches into the Storage Box,
never into the server, and its credential there is read-only. See
[storagebox-setup.md](./storagebox-setup.md) and
[onprem-pull-setup.md](./onprem-pull-setup.md) for the full setup.

```
┌─────────────────────────── ResourceSpace server ───────────────────────────┐
│  mariadb ──(network dump)──┐                                                 │
│  rs_assets ─(ro mirror)────┼──►  backup sidecar  ──►  `backups` volume       │
│  Dokploy env (secrets) ────┘        (nightly)          /backups/…           │
└───────────────────────────────────────────────────────────────┬───────────┘
                                                                  │ rsync/SSH PUSH
                                                                  │ (RW sub-account)
                                                        ┌─────────▼──────────┐
                                                        │   Hetzner Storage   │
                                                        │   Box (copy 2)      │
                                                        └─────────┬──────────┘
                                                                  │ rsync/SSH PULL
                                                                  │ (RO sub-account)
                                                        ┌─────────▼──────────┐
                                                        │  off-site / on-prem │
                                                        │  mirror + snapshots │
                                                        │       (copy 3)      │
                                                        └─────────────────────┘
```

## What is backed up

| Item | Source | How | In backup |
| --- | --- | --- | --- |
| **Database** | `mariadb` container (network) | `mariadb-dump --single-transaction` → gzip, dated, kept N days | `db/resourcespace-<ts>.sql.gz` (+ `-latest`) |
| **Filestore (assets)** | `rs_assets` volume (mounted read-only) | incremental `rsync` mirror | `filestore/` |
| **Secrets** *(optional)* | Dokploy env vars | age-encrypted snapshot, if `BACKUP_SECRETS_AGE_RECIPIENT` set | `secrets/secrets-<ts>.env.age` |
| Success beacon / summary | — | written on each successful run | `.backup-ok`, `manifest.txt` |

### Deliberately **not** backed up
- `clip_cache`, `faces_models` — regenerable ML caches. Re-created by the CLIP/faces
  services; re-run vector/face generation after a restore (see [restore.md](./restore.md)).
- Application code & compose config — already versioned in **this git repo**.
- `db.env` / `config.php` in the repo hold **placeholders**; the real secrets are
  injected by Dokploy at deploy time (see the secrets note below).

### The secrets caveat (important)
A full restore needs the **Dokploy environment variables**, at minimum
`SCRAMBLE_KEY`, `API_SCRAMBLE_KEY`, `MYSQL_ROOT_PASSWORD`,
`MYSQL_READ_ONLY_PASSWORD`, and `SIMPLESAML_ADMIN_PASSWORD_HASH`. Without
`SCRAMBLE_KEY` the filestore paths can't be resolved — the assets are there but
unreadable by RS. Two ways to cover this:

1. **Automatic + encrypted (recommended):** set `BACKUP_SECRETS_AGE_RECIPIENT`
   to an [age](https://github.com/FiloSottile/age) **public** key. Each backup
   then includes `secrets-<ts>.env.age`, decryptable only with the matching
   private key (kept in your password manager, *not* on either server).
2. **Manual:** leave it unset and instead export the env from Dokploy
   (this stack → Environment) into your password manager. The sidecar writes
   `secrets/README.txt` as a reminder.

Either way, `secrets/README.txt` is rewritten on **every** run to describe
that run's actual outcome (captured-with-recovery-instructions, or
not-captured-with-a-reminder) — so it can never be a leftover from a config
that no longer applies, e.g. after toggling `BACKUP_SECRETS_AGE_RECIPIENT` on
or off between runs. Dated `secrets-<ts>.env.age` snapshots from before a
toggle-off are left in place and age out on the normal
`BACKUP_RETENTION_DAYS` schedule, independent of the current setting.

## The backup sidecar

A small Alpine container (`backup/`) added to `docker-compose.yaml`. It runs
`busybox crond` and, on schedule, executes `backup.sh`. It talks to `mariadb`
over the `backend` network for the dump and mounts `rs_assets` **read-only** —
it can never modify your assets.

### Configuration (env, with defaults)

| Var | Default | Purpose |
| --- | --- | --- |
| `BACKUP_TZ` | `America/Los_Angeles` | Timezone for the schedule (DST-aware) |
| `BACKUP_CRON` | `0 2 * * *` | Cron expression (nightly 02:00) |
| `BACKUP_RETENTION_DAYS` | `7` | Days of DB dumps / secret snapshots to keep on the server |
| `BACKUP_ON_START` | `false` | Run one backup immediately on container start (useful to verify a deploy) |
| `BACKUP_SECRETS_AGE_RECIPIENT` | *(unset)* | age public key; if set, include an encrypted secrets snapshot |
| `BACKUP_MAX_AGE_HOURS` | `26` | Healthcheck: mark unhealthy if the last success is older than this |
| `STORAGE_BOX_HOST` | *(unset)* | Storage Box hostname (`u123456.your-storagebox.de`); unset = stage locally only, no off-site push |
| `STORAGE_BOX_USER` | *(unset)* | The **RW** sub-account username |
| `STORAGE_BOX_PORT` | `23` | Storage Box rsync/SSH port (always 23, not 22) |
| `STORAGE_BOX_REMOTE_PATH` | `./resourcespace/` | Path on the Storage Box, relative to the RW sub-account's root |
| `STORAGE_BOX_SSH_KEY_B64` | *(unset)* | **Base64-encoded** private key (RW sub-account) — decoded to disk in the container at start. Base64, not raw, because Dokploy's Environment tab parses one `KEY=VALUE` per line like a `.env` file and would corrupt a raw multi-line PEM block |
| `STORAGE_BOX_HOST_KEY` | *(unset)* | Pinned host key line (from `ssh-keyscan`); push refuses to run without this once `STORAGE_BOX_HOST` is set |

The DB/secret env vars (`MYSQL_*`, `SCRAMBLE_KEY`, …) are passed through from the
same Dokploy environment the other services use. See
[storagebox-setup.md](./storagebox-setup.md) for how to generate and wire in
the `STORAGE_BOX_*` values.

> `.backup-ok` (and therefore the healthcheck / `BACKUP_MAX_AGE_HOURS`) is only
> stamped once the off-site push succeeds, when `STORAGE_BOX_HOST` is set — a
> stalled push shows up the same way a stalled local dump would.

> Filestore is kept as a single **live mirror** on the server (not dated) to
> keep server disk use flat; point-in-time history lives on the off-site box as
> hardlinked snapshots. DB dumps *are* dated on the server so you can roll back
> to a specific night even before the off-site pull runs.

## Operating it

```bash
# Watch the sidecar
docker compose logs -f backup

# Trigger a backup on demand
docker compose exec backup /usr/local/bin/backup.sh

# Inspect what's staged
docker compose exec backup sh -c 'cat /backups/manifest.txt; echo; ls -lah /backups/db'

# Health (fresh backup?) — also surfaced by `docker ps` STATUS
docker compose exec backup /usr/local/bin/healthcheck.sh
```

### First deploy
Set `BACKUP_ON_START=true` for the first deploy (or run the on-demand command
above) so you get an immediate backup to verify, then unset it.

### Verifying a backup is restorable
A backup you haven't restored isn't a backup. See [restore.md](./restore.md) and
do a **quarterly test restore** onto a throwaway box.

## Off-site copy
Two hops complete the 3-2-1 scheme:
1. **[storagebox-setup.md](./storagebox-setup.md)** — provision a Hetzner
   Storage Box, its RW (push) and RO (pull) sub-accounts, and turn on Storage
   Box Snapshots as the backstop against a compromised push credential.
2. **[onprem-pull-setup.md](./onprem-pull-setup.md)** — point your on-prem box
   at the Storage Box's RO sub-account to pull down dated, encrypted-at-rest
   snapshots.
