# Off-site / On-prem Pull Setup

Wire up the on-prem box that pulls backups down for good — the third copy in
the 3-2-1 scheme, and the one that survives even Hetzner's account being gone.

**Model:** the backup sidecar **pushes** its staged backups to a Hetzner
Storage Box (copy 2); the on-prem box then **pulls** from that Storage Box
over rsync/SSH (copy 3), using a **read-only** sub-account. The on-prem box
never talks to the ResourceSpace server directly — it only ever reaches the
Storage Box, and can't write to it even if compromised.

```
resourcespace server ──push (RW sub-account)──►  Storage Box  ◄──pull (RO sub-account)── on-prem box
   (backup sidecar)                                                                    mirror/ + snapshots/
                                                                                        (on an ENCRYPTED volume)
```

> Provision the Storage Box and both sub-accounts first —
> [storagebox-setup.md](./storagebox-setup.md). This doc picks up from there:
> you should already have a **read-only** sub-account (username + host) and
> its keypair before continuing.

## Prerequisites
- The on-prem box (any Linux with `rsync`, `ssh`, `cron`/systemd).
- The Storage Box's **read-only pull sub-account** set up per
  [storagebox-setup.md](./storagebox-setup.md), with its keypair generated on
  this box and the pinned host key from that doc's step 7.

---

## Step 1 — Encrypt the destination at rest (on-prem)

Backups contain the database and (if enabled) secrets. Put the destination on
an encrypted volume:

```bash
# example: LUKS on a dedicated disk/partition, mounted at /srv/backups
sudo cryptsetup luksFormat /dev/sdX
sudo cryptsetup open /dev/sdX rsbackup && sudo mkfs.ext4 /dev/mapper/rsbackup
sudo mkdir -p /srv/backups && sudo mount /dev/mapper/rsbackup /srv/backups
```
(Automate unlock with a keyfile on the boot disk, or a TPM/`systemd-cryptenroll`,
per your threat model.)

## Step 2 — Schedule the pull (on-prem)

Use `scripts/onprem-pull.sh` from this repo, unchanged — only what `SERVER`
points at has changed (the Storage Box's RO sub-account, not the
ResourceSpace server). Run it a bit **after** the server's backup *and* push
window (default backup at 02:00 PT; push follows immediately after, so 03:30
is comfortable).

```bash
# test once by hand:
SERVER=<pull-user>@<box-host> SSH_KEY=~/.ssh/storagebox_pull SSH_PORT=23 \
DEST=/srv/backups/resourcespace bash scripts/onprem-pull.sh
```

Then a systemd timer:
```ini
# /etc/systemd/system/rs-backup-pull.service
[Unit]
Description=Pull ResourceSpace backups from the Storage Box
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=SERVER=<pull-user>@<box-host>
Environment=SSH_KEY=/root/.ssh/storagebox_pull
Environment=SSH_PORT=23
Environment=DEST=/srv/backups/resourcespace
Environment=SNAP_RETENTION=30
ExecStart=/opt/digital-resource-management/scripts/onprem-pull.sh
```
```ini
# /etc/systemd/system/rs-backup-pull.timer
[Unit]
Description=Nightly ResourceSpace backup pull

[Timer]
OnCalendar=*-*-* 03:30:00 America/Los_Angeles
Persistent=true

[Install]
WantedBy=timers.target
```
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now rs-backup-pull.timer
systemctl list-timers rs-backup-pull.timer
```

`onprem-pull.sh` takes `SSH_PORT` already (defaults to 22) — Storage Boxes
require **23** for rsync/SSH, so it must be set explicitly as shown above.

The pull keeps `mirror/` (latest) plus hardlinked dated `snapshots/<ts>/`
(default 30 kept), and spot-checks the newest DB dump with `gzip -t`.

## Step 3 — Monitor
- Point a dead-man's-switch (e.g. Healthchecks.io) at the end of the pull: append
  `&& curl -fsS <ping-url>` so you're alerted if a night is missed.
- The server sidecar's own healthcheck (`BACKUP_MAX_AGE_HOURS`) now only
  reports healthy once the **push to the Storage Box** also succeeds (see
  `backup.sh`'s `.backup-ok` handling) — a stalled push surfaces there, not
  just a stalled local stage.
- Storage Box's own Snapshots (enabled in `storagebox-setup.md` step 3) are
  your backstop if the RW push credential is ever misused — check
  periodically that snapshots are actually accumulating in the Robot UI, not
  just configured.

## Restoring from what you pulled
See [restore.md](./restore.md) → "Restoring from the off-site box".

---

## Hardening notes / rationale
- **Pull, read-only** — the on-prem box's sub-account is read-only at the
  Storage Box level; even a fully compromised on-prem box can't alter or
  delete the off-site copy.
- **The server never talks to on-prem** — it only pushes to the Storage Box.
  A compromised ResourceSpace server can at worst tamper with the Storage Box
  copy (mitigated by Storage Box Snapshots); it has no path into your
  on-prem network at all.
- **Encrypted at rest** — the on-prem copy holds your DB and secrets; treat it
  as sensitively as the server.
- **Pinned host key** — both the push and pull legs use a pinned
  `known_hosts`/`UserKnownHostsFile`, not TOFU, since these run unattended.

## If you're migrating from the old direct-to-server pull
If this box used to pull straight from the ResourceSpace server (the
`rsbackup` account installed by `scripts/setup-onprem-pull.sh`), that script
and account are now legacy — see storagebox-setup.md step 11 to decommission
them once the Storage Box path has run cleanly for a few nights.
