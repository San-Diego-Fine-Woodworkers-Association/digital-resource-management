#!/usr/bin/env bash
# Run on the OFF-SITE / on-prem box to PULL the staged backups and keep dated,
# space-efficient snapshots. Schedule via cron / systemd timer to run AFTER the
# server's nightly backup window. See docs/onprem-pull-setup.md.
#
# Usage:
#   SERVER=rsbackup@5.78.204.140 SSH_KEY=~/.ssh/rs_backup \
#   DEST=/srv/backups/resourcespace bash scripts/onprem-pull.sh
set -euo pipefail

SERVER="${SERVER:?set SERVER=user@host, e.g. rsbackup@<server-ip>}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/rs_backup}"
DEST="${DEST:-/srv/backups/resourcespace}"   # put this on an ENCRYPTED (LUKS) volume
SSH_PORT="${SSH_PORT:-22}"
SNAP_RETENTION="${SNAP_RETENTION:-30}"        # number of dated snapshots to keep

log(){ printf '%s [onprem-pull] %s\n' "$(date -u +%FT%TZ)" "$*"; }

mkdir -p "$DEST/mirror" "$DEST/snapshots"
ts="$(date -u +%Y%m%dT%H%M%SZ)"

log "pulling from $SERVER -> $DEST/mirror ..."
# The remote key is command-locked to `rrsync -ro <root>`, so the remote path is
# relative to that root: ':' (or ':/') means the whole staged backup tree.
# --delete keeps the mirror faithful; the dated snapshot below preserves history.
rsync -az --delete --numeric-ids --stats \
  -e "ssh -i $SSH_KEY -p $SSH_PORT -o BatchMode=yes -o StrictHostKeyChecking=accept-new" \
  "$SERVER":/ "$DEST/mirror/"

# Space-efficient dated snapshot: unchanged files are hardlinked, so N snapshots
# cost ~one copy plus the deltas. (Requires mirror + snapshots on one filesystem.)
log "snapshotting -> snapshots/$ts"
cp -al "$DEST/mirror" "$DEST/snapshots/$ts"

# Integrity spot-check: the newest DB dump must pass a gzip test.
latest="$(ls -1t "$DEST"/mirror/db/*-latest.sql.gz 2>/dev/null | head -1 || true)"
if [ -n "$latest" ] && gzip -t "$latest" 2>/dev/null; then
  log "latest DB dump integrity OK: $(basename "$latest")"
else
  log "WARNING: latest DB dump missing or failed gzip test — investigate!"
fi

# Freshness check against the server's success beacon.
if [ -f "$DEST/mirror/.backup-ok" ]; then
  log "server last-success beacon: $(cat "$DEST/mirror/.backup-ok")"
else
  log "WARNING: no .backup-ok beacon in pulled data"
fi

# Retention: keep the newest $SNAP_RETENTION snapshots.
log "pruning to newest $SNAP_RETENTION snapshots..."
ls -1dt "$DEST"/snapshots/*/ 2>/dev/null | tail -n +"$((SNAP_RETENTION + 1))" | while read -r old; do
  log "removing old snapshot: $old"
  rm -rf "$old"
done

log "pull complete. total: $(du -sh "$DEST" 2>/dev/null | cut -f1)"
