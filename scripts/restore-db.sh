#!/usr/bin/env bash
# Restore a ResourceSpace database dump into the running stack's mariadb
# container. Run on the SERVER. DESTRUCTIVE: overwrites the current database.
#
# Usage: restore-db.sh <dump.sql.gz> [mariadb-container-name-substring]
set -euo pipefail

DUMP="${1:?usage: restore-db.sh <dump.sql.gz> [mariadb-container-substring]}"
NEEDLE="${2:-mariadb}"
[ -f "$DUMP" ] || { echo "no such file: $DUMP" >&2; exit 1; }

cid="$(docker ps --format '{{.Names}}' | grep -i "$NEEDLE" | head -1 || true)"
[ -n "$cid" ] || { echo "no running container matching '$NEEDLE'" >&2; exit 1; }

# Pull creds from the container's own env so secrets aren't retyped on the CLI.
rootpw="$(docker exec "$cid" printenv MARIADB_ROOT_PASSWORD 2>/dev/null || true)"
db="$(docker exec "$cid" printenv MARIADB_DATABASE 2>/dev/null || echo resourcespace)"
[ -n "$rootpw" ] || { echo "could not read MARIADB_ROOT_PASSWORD from $cid" >&2; exit 1; }

echo "Container : $cid"
echo "Database  : $db"
echo "Dump      : $DUMP"
echo
echo "This will OVERWRITE the current '$db' database. Ctrl-C to abort; Enter to proceed."
read -r _

# Dumps are single-database (no CREATE DATABASE/USE), so pipe straight into `$db`.
gunzip -c "$DUMP" | docker exec -i "$cid" sh -c "exec mariadb -u root -p\"$rootpw\" \"$db\""

echo "Restore complete."
echo "Next: restart the resourcespace container, then log in as admin — RS may"
echo "prompt to run a schema upgrade. See docs/restore.md for post-restore steps."
