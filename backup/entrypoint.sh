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

# Cron job output -> container stdout (/proc/1/fd/1) so it lands in `docker logs`.
mkdir -p /etc/crontabs
echo "${BACKUP_CRON} /usr/local/bin/backup.sh >> /proc/1/fd/1 2>&1" > /etc/crontabs/root

if [ "${BACKUP_ON_START}" = "true" ]; then
  echo "[backup] BACKUP_ON_START=true — running an initial backup now..."
  /usr/local/bin/backup.sh || echo "[backup] initial backup FAILED (see output above); cron will retry on schedule."
fi

# -f foreground, -l 8 log level (busybox crond logs job start/stop to stderr).
exec crond -f -l 8
