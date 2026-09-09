#!/bin/sh
# Healthy only if the last SUCCESSFUL backup is recent enough. Lets Dokploy /
# `docker ps` surface a stalled backup. Tune the window with BACKUP_MAX_AGE_HOURS.
set -eu
MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-26}"
STAMP="${BACKUP_DIR:-/backups}/.backup-ok"

[ -f "$STAMP" ] || { echo "no successful backup yet ($STAMP missing)"; exit 1; }

now="$(date +%s)"
then="$(stat -c %Y "$STAMP" 2>/dev/null || date -r "$STAMP" +%s)"
age_h=$(( (now - then) / 3600 ))

if [ "$age_h" -gt "$MAX_AGE_HOURS" ]; then
  echo "last backup is ${age_h}h old (> ${MAX_AGE_HOURS}h)"
  exit 1
fi
echo "last backup ${age_h}h ago — OK"
