# Off-site / On-prem Pull Setup

Wire up the off-site box that pulls the staged backups. Do this **when the box
exists**; until then the sidecar still stages backups on the server (copy 1) —
this adds the off-site copy (copy 2) and history.

**Model:** the on-prem box initiates an rsync-over-SSH **pull**. The server holds
no credentials into your network. The pull account is read-only, command-locked,
and source-pinned, so a compromised on-prem box gets read-only access to the
backup staging directory and nothing else.

```
on-prem box  ──ssh (key: command="rrsync -ro", from=<on-prem IP>)──►  server:/var/backups/resourcespace
     │                                                                         ▲
     └── mirror/ + dated snapshots/ (on an ENCRYPTED volume)          staged by the backup sidecar
```

## Prerequisites
- The on-prem box (any Linux with `rsync`, `ssh`, `cron`/systemd). A **static or
  known egress IP** is strongly preferred (pins the key and firewall). If it's
  dynamic, you can widen `from=`/UFW to a range or a dynamic-DNS-updated rule.
- Server-side priming already done (from `Digital-Services-Init`): UFW + SSH
  hardening + fail2ban. This adds a narrower rule on top.

---

## Step 1 — Expose the backups to a low-privilege user (server)

The sidecar writes to the `backups` **named volume**, which lives under
`/var/lib/docker/volumes/…` — a path non-root users cannot even traverse. Give a
low-privilege user a readable path by pointing the volume at a host directory.

In Dokploy, add a bind mount for the backup sidecar (Advanced → Volumes), or set
it in an override so the `backups` volume maps to a host path:

```yaml
# docker-compose.override.yaml (or the equivalent Dokploy volume setting)
services:
  backup:
    volumes:
      - /var/backups/resourcespace:/backups
```

```bash
sudo mkdir -p /var/backups/resourcespace
# redeploy the stack so the sidecar writes here, then confirm a backup lands:
ls -la /var/backups/resourcespace/db
```

> Switching the volume discards the *old* staged copy (dumps + mirror) — that's
> fine, the next run repopulates it. Do this before the first off-site pull.

## Step 2 — Generate a key pair (on-prem box)

```bash
ssh-keygen -t ed25519 -f ~/.ssh/rs_backup -C "onprem-backup" -N ""
cat ~/.ssh/rs_backup.pub    # copy this; it goes to the server in step 3
```
Keep the **private** key on the on-prem box only.

## Step 3 — Grant read-only pull access (server, as root)

Copy the on-prem **public** key to the server, then run the helper from this repo:

```bash
ONPREM_PUBKEY=/root/onprem_backup.pub \
ONPREM_IP=<on-prem-egress-ip> \
BACKUP_SRC=/var/backups/resourcespace \
sudo -E bash scripts/setup-onprem-pull.sh
```

It creates the `rsbackup` user (no sudo), grants it read-only ACLs on
`/var/backups/resourcespace` (including a default ACL so nightly files inherit
access), installs the key **command-locked** to `rrsync -ro` and **pinned** to
the on-prem IP, and adds a UFW allow for SSH from that IP.

Verify the lock actually holds:
```bash
# from the on-prem box:
rsync -az --dry-run -e "ssh -i ~/.ssh/rs_backup" rsbackup@<server-ip>: /tmp/rs-test/  # works
ssh -i ~/.ssh/rs_backup rsbackup@<server-ip> 'id'                                     # MUST fail
```

## Step 4 — Encrypt the destination at rest (on-prem)

Backups contain the database and (if enabled) secrets. Put the destination on an
encrypted volume:

```bash
# example: LUKS on a dedicated disk/partition, mounted at /srv/backups
sudo cryptsetup luksFormat /dev/sdX
sudo cryptsetup open /dev/sdX rsbackup && sudo mkfs.ext4 /dev/mapper/rsbackup
sudo mkdir -p /srv/backups && sudo mount /dev/mapper/rsbackup /srv/backups
```
(Automate unlock with a keyfile on the boot disk, or a TPM/`systemd-cryptenroll`,
per your threat model.)

## Step 5 — Schedule the pull (on-prem)

Use `scripts/onprem-pull.sh` from this repo. Run it a bit **after** the server's
backup window (default 02:00 PT → pull at, say, 03:30).

```bash
# test once by hand:
SERVER=rsbackup@<server-ip> SSH_KEY=~/.ssh/rs_backup \
DEST=/srv/backups/resourcespace bash scripts/onprem-pull.sh
```

Then a systemd timer:
```ini
# /etc/systemd/system/rs-backup-pull.service
[Unit]
Description=Pull ResourceSpace backups from the server
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=SERVER=rsbackup@<server-ip>
Environment=SSH_KEY=/root/.ssh/rs_backup
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

The pull keeps `mirror/` (latest) plus hardlinked dated `snapshots/<ts>/`
(default 30 kept), and spot-checks the newest DB dump with `gzip -t`.

## Step 6 — Monitor
- Point a dead-man's-switch (e.g. Healthchecks.io) at the end of the pull: append
  `&& curl -fsS <ping-url>` so you're alerted if a night is missed.
- The server sidecar's own healthcheck (`BACKUP_MAX_AGE_HOURS`) surfaces a
  stalled staging step in `docker ps` / Dokploy.

## Restoring from what you pulled
See [restore.md](./restore.md) → "Restoring from the off-site box".

---

## Hardening notes / rationale
- **`command="rrsync -ro …"`** — the key can *only* run a read-only rsync rooted
  at the backup dir. No shell, no other command.
- **`restrict`** — disables pty, port/agent/X11 forwarding.
- **`from="<ip>"`** — the key is rejected from any other source address.
- **ACLs, not root** — the pull user reads via a granted ACL; it isn't in
  `docker`/`sudo` and can't reach the rest of the box.
- **Encrypted at rest** — the off-site copy holds your DB and secrets; treat it
  as sensitively as the server.
- **Pull, not push** — the server can't reach into your network; only the on-prem
  box initiates.
