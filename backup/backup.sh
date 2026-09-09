#!/bin/sh
# Stage a consistent backup of the ResourceSpace stack onto $BACKUP_DIR.
#
# Produces:
#   $BACKUP_DIR/db/<db>-<ts>.sql.gz         point-in-time logical DB dump (kept N days)
#   $BACKUP_DIR/db/<db>-latest.sql.gz       -> newest dump (symlink)
#   $BACKUP_DIR/filestore/                  incremental mirror of the RS filestore
#   $BACKUP_DIR/secrets/secrets-<ts>.env.age  (only if BACKUP_SECRETS_AGE_RECIPIENT set)
#   $BACKUP_DIR/manifest.txt                human-readable summary of the last run
#   $BACKUP_DIR/.backup-ok                  ISO timestamp of last SUCCESS (healthcheck)
#
# The off-site box pulls $BACKUP_DIR over rsync/SSH (see docs/onprem-pull-setup.md).
set -eu
# pipefail so a failing mariadb-dump isn't masked by a succeeding gzip further
# down the pipe (busybox ash / bash support it; harmless elsewhere). The
# "Dump completed" trailer check below is a second, shell-independent guard.
set -o pipefail 2>/dev/null || true

BACKUP_DIR="${BACKUP_DIR:-/backups}"
DB_HOST="${MYSQL_SERVER:-mariadb}"
DB_USER="${MYSQL_ROOT_USER:-root}"
DB_PASS="${MYSQL_ROOT_PASSWORD:?MYSQL_ROOT_PASSWORD is required}"
# config.php reads MYSQL_DATABASE; DB_NAME kept as a fallback for older env sets.
DB_NAME="${MYSQL_DATABASE:-${DB_NAME:-resourcespace}}"
FILESTORE_SRC="${FILESTORE_SRC:-/data/filestore}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
SECRETS_AGE_RECIPIENT="${BACKUP_SECRETS_AGE_RECIPIENT:-}"

ts="$(date -u +%Y%m%dT%H%M%SZ)"
log() { printf '%s [backup] %s\n' "$(date -u +%FT%TZ)" "$*"; }
fail() { printf '%s [backup] ERROR: %s\n' "$(date -u +%FT%TZ)" "$*" >&2; exit 1; }

# Single-run lock (mkdir is atomic) so a long run never overlaps the next tick.
LOCK="$BACKUP_DIR/.lock"
mkdir -p "$BACKUP_DIR"
if ! mkdir "$LOCK" 2>/dev/null; then
  log "another backup run is in progress ($LOCK exists) — skipping this tick."
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

mkdir -p "$BACKUP_DIR/db" "$BACKUP_DIR/filestore" "$BACKUP_DIR/secrets"

# mariadb-dump on newer clients, mysqldump on older ones.
DUMP="$(command -v mariadb-dump || command -v mysqldump || true)"
[ -n "$DUMP" ] || fail "no mariadb-dump/mysqldump found in image"

# ---------------- 1. Database (transaction-consistent) ----------------
log "Dumping database '$DB_NAME' from '$DB_HOST' with $DUMP..."
tmp="$BACKUP_DIR/db/.$DB_NAME-$ts.sql.gz.partial"
out="$BACKUP_DIR/db/$DB_NAME-$ts.sql.gz"
# --single-transaction: consistent snapshot without locking (InnoDB).
# --quick: stream rows (low memory). routines/triggers/events: full schema.
if ! "$DUMP" -h "$DB_HOST" -u "$DB_USER" -p"$DB_PASS" \
      --single-transaction --quick --routines --triggers --events \
      --default-character-set=utf8mb4 "$DB_NAME" | gzip -c > "$tmp"; then
  rm -f "$tmp"
  fail "database dump failed"
fi
# Sanity 1: gzip stream must be intact.
gzip -t "$tmp" || { rm -f "$tmp"; fail "dump gzip integrity check failed"; }
# Sanity 2: mariadb-dump writes a "-- Dump completed" trailer on a clean run.
# Its absence means a truncated/failed dump even if the pipe exited 0.
if ! gzip -cd "$tmp" | tail -c 256 | grep -q 'Dump completed'; then
  rm -f "$tmp"
  fail "dump missing 'Dump completed' trailer — likely a connection/auth failure or truncation"
fi
mv "$tmp" "$out"
ln -sf "$(basename "$out")" "$BACKUP_DIR/db/$DB_NAME-latest.sql.gz"
log "DB dump OK: db/$(basename "$out") ($(du -h "$out" | cut -f1))"

# ---------------- 2. Filestore (incremental mirror) ----------------
if [ -d "$FILESTORE_SRC" ]; then
  log "Mirroring filestore from $FILESTORE_SRC ..."
  # -a preserve everything, --delete keep the mirror faithful, exclude RS scratch.
  rsync -a --delete \
    --exclude 'tmp/' --exclude 'system/tmp/' \
    "$FILESTORE_SRC"/ "$BACKUP_DIR/filestore"/
  log "Filestore mirror OK ($(du -sh "$BACKUP_DIR/filestore" | cut -f1))"
else
  log "WARNING: filestore source $FILESTORE_SRC not found — skipping filestore mirror."
fi

# ---------------- 3. Secrets (optional, encrypted at rest) ----------------
# A full restore also needs the deployment secrets (SCRAMBLE_KEY resolves
# filestore paths; DB creds; SAML admin hash). These are injected by Dokploy,
# not stored in git. If an age recipient is configured we capture them ENCRYPTED
# so the backup is self-contained; otherwise we leave a reminder to export them
# from Dokploy into a password manager. See docs/restore.md.
SECRET_VARS="DOMAIN_NAME MYSQL_SERVER MYSQL_ROOT_USER MYSQL_ROOT_PASSWORD \
MYSQL_READ_ONLY_USER MYSQL_READ_ONLY_PASSWORD MYSQL_DATABASE DB_NAME \
SCRAMBLE_KEY API_SCRAMBLE_KEY EMAIL_NOTIFY EMAIL_FROM SIMPLESAML_ADMIN_PASSWORD_HASH"

if [ -n "$SECRETS_AGE_RECIPIENT" ]; then
  log "Writing age-encrypted secrets snapshot..."
  secret_out="$BACKUP_DIR/secrets/secrets-$ts.env.age"
  {
    echo "# ResourceSpace deployment secrets — captured $ts"
    echo "# Decrypt with: age -d -i <your-key> secrets-$ts.env.age"
    for v in $SECRET_VARS; do
      eval "val=\${$v:-}"
      # `if` (not `&&`) so an empty var doesn't make the block exit non-zero,
      # which under set -e + pipefail would abort the pipe into age.
      if [ -n "${val:-}" ]; then printf '%s=%s\n' "$v" "$val"; fi
    done
  } | age -r "$SECRETS_AGE_RECIPIENT" -o "$secret_out"
  ln -sf "$(basename "$secret_out")" "$BACKUP_DIR/secrets/secrets-latest.env.age"
  log "Secrets snapshot OK: secrets/$(basename "$secret_out") (encrypted)"
else
  cat > "$BACKUP_DIR/secrets/README.txt" <<EOF
Secrets are NOT captured here (BACKUP_SECRETS_AGE_RECIPIENT is unset).

A full restore ALSO needs the Dokploy environment variables, at minimum:
  SCRAMBLE_KEY, API_SCRAMBLE_KEY, MYSQL_ROOT_PASSWORD,
  MYSQL_READ_ONLY_PASSWORD, SIMPLESAML_ADMIN_PASSWORD_HASH
Without SCRAMBLE_KEY the filestore paths cannot be resolved.

Export these from the Dokploy UI (this stack -> Environment) and store them
in your password manager / encrypted vault. To capture them here automatically
(encrypted), set BACKUP_SECRETS_AGE_RECIPIENT to an age public key.
See docs/restore.md.
EOF
  log "No age recipient set — wrote secrets/README.txt reminder instead."
fi

# ---------------- 4. Retention ----------------
log "Pruning DB dumps older than ${RETENTION_DAYS} day(s)..."
find "$BACKUP_DIR/db" -maxdepth 1 -type f -name "$DB_NAME-*.sql.gz" -mtime "+$RETENTION_DAYS" -print -delete || true
find "$BACKUP_DIR/secrets" -maxdepth 1 -type f -name 'secrets-*.env.age' -mtime "+$RETENTION_DAYS" -print -delete 2>/dev/null || true

# ---------------- 5. Manifest + health beat ----------------
{
  echo "last backup     : $(date -u +%FT%TZ)"
  echo "database        : db/$DB_NAME-$ts.sql.gz"
  echo "filestore mirror: filestore/  ($(du -sh "$BACKUP_DIR/filestore" 2>/dev/null | cut -f1))"
  echo "secrets         : $([ -n "$SECRETS_AGE_RECIPIENT" ] && echo 'secrets/secrets-latest.env.age (age-encrypted)' || echo 'NOT captured — see secrets/README.txt')"
  echo "retention       : ${RETENTION_DAYS}d (db + secrets); filestore is a single live mirror"
  echo "total size      : $(du -sh "$BACKUP_DIR" 2>/dev/null | cut -f1)"
} > "$BACKUP_DIR/manifest.txt"

date -u +%FT%TZ > "$BACKUP_DIR/.backup-ok"
log "Backup complete."
