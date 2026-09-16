#!/bin/sh
# Entrypoint for the backup sidecar: install a crontab from $BACKUP_CRON and run
# busybox crond in the foreground. Optionally run one backup immediately on
# start (handy for first-deploy verification).
set -eu

: "${TZ:=America/Los_Angeles}"
: "${BACKUP_CRON:=0 2 * * *}"        # default: nightly 02:00 (container TZ)
: "${BACKUP_ON_START:=false}"

echo "[backup] timezone   : ${TZ}"
echo "[backup] schedule   : ${BACKUP_CRON}"
echo "[backup] retention  : ${BACKUP_RETENTION_DAYS:-7} day(s) (db + secrets)"
echo "[backup] run-on-start: ${BACKUP_ON_START}"

# Materialize the Storage Box push key + pinned host key from env vars (Dokploy
# secrets), if configured. Kept out of the image / git; written fresh on every
# container start so a key rotation just needs a redeploy.
#
# The private key is stored BASE64-ENCODED (STORAGE_BOX_SSH_KEY_B64), not raw.
# Most "paste KEY=VALUE" environment UIs (Dokploy's Environment tab included)
# parse one variable per line, same as a .env file — a raw multi-line PEM
# block pasted in would get split across "lines" and silently truncated or
# corrupted. Base64 collapses it to one line, which is unambiguous everywhere.
if [ -n "${STORAGE_BOX_SSH_KEY_B64:-}" ]; then
  echo "[backup] storage box: push configured (${STORAGE_BOX_USER:-?}@${STORAGE_BOX_HOST:-?})"
  install -d -m 0700 /root/.ssh
  if ! printf '%s' "${STORAGE_BOX_SSH_KEY_B64}" | base64 -d > /root/.ssh/storagebox_ed25519 2>/dev/null; then
    echo "[backup] ERROR: STORAGE_BOX_SSH_KEY_B64 did not decode as base64 — check it was encoded with 'base64 -w0' (no line wrapping) and pasted in full." >&2
    rm -f /root/.ssh/storagebox_ed25519
  fi
  chmod 0600 /root/.ssh/storagebox_ed25519
  if [ -n "${STORAGE_BOX_HOST_KEY:-}" ]; then
    printf '%s\n' "${STORAGE_BOX_HOST_KEY}" > /root/.ssh/storagebox_known_hosts
    chmod 0644 /root/.ssh/storagebox_known_hosts
  else
    echo "[backup] WARNING: STORAGE_BOX_HOST_KEY not set — push will refuse to run rather than TOFU-trust the host. See docs/storagebox-setup.md."
  fi
else
  echo "[backup] storage box: not configured (STORAGE_BOX_SSH_KEY_B64 unset) — staging locally only."
fi

# Cron job output -> container stdout (/proc/1/fd/1) so it lands in `docker logs`.
mkdir -p /etc/crontabs
echo "${BACKUP_CRON} /usr/local/bin/backup.sh >> /proc/1/fd/1 2>&1" > /etc/crontabs/root

if [ "${BACKUP_ON_START}" = "true" ]; then
  echo "[backup] BACKUP_ON_START=true — running an initial backup now..."
  /usr/local/bin/backup.sh || echo "[backup] initial backup FAILED (see output above); cron will retry on schedule."
fi

# -f foreground, -l 8 log level (busybox crond logs job start/stop to stderr).
exec crond -f -l 8
