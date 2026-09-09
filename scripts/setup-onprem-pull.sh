#!/usr/bin/env bash
# Run on the ResourceSpace SERVER (as root) when the off-site/on-prem box is
# ready. Grants that box READ-ONLY, command-locked, source-pinned rsync access
# to the staged backups — no shell, no sudo, no write. Idempotent.
#
# Prereq: the backups must live at a host path the backup user can traverse.
# The `backups` named volume lives under /var/lib/docker/volumes, which non-root
# users cannot enter, so bind-mount it to $BACKUP_SRC first — see
# docs/onprem-pull-setup.md ("Expose the backups to a low-privilege user").
#
# Usage:
#   ONPREM_PUBKEY=/root/onprem_backup.pub ONPREM_IP=203.0.113.10 \
#     sudo -E bash scripts/setup-onprem-pull.sh
set -euo pipefail

BACKUP_USER="${BACKUP_USER:-rsbackup}"
BACKUP_SRC="${BACKUP_SRC:-/var/backups/resourcespace}"
ONPREM_PUBKEY="${ONPREM_PUBKEY:-}"   # path to the on-prem box's PUBLIC key
ONPREM_IP="${ONPREM_IP:-}"           # on-prem egress IP (pins key + firewall)
SSH_PORT="${SSH_PORT:-22}"
PIN_UFW="${PIN_UFW:-true}"

log(){ printf '[setup-onprem-pull] %s\n' "$*"; }
err(){ printf '[setup-onprem-pull] ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || err "run as root"
[ -n "$ONPREM_PUBKEY" ] && [ -f "$ONPREM_PUBKEY" ] || err "ONPREM_PUBKEY must point to the on-prem box's public key file"
[ -n "$ONPREM_IP" ] || err "ONPREM_IP is required (on-prem egress IP; pins the key with from= and the firewall)"

# rrsync ships with the rsync package; locate it or unpack the doc copy.
RRSYNC=""
for c in /usr/bin/rrsync /usr/local/bin/rrsync; do [ -x "$c" ] && RRSYNC="$c" && break; done
if [ -z "$RRSYNC" ]; then
  if [ -f /usr/share/doc/rsync/scripts/rrsync.gz ]; then
    gunzip -c /usr/share/doc/rsync/scripts/rrsync.gz > /usr/local/bin/rrsync && chmod +x /usr/local/bin/rrsync
    RRSYNC=/usr/local/bin/rrsync
  elif [ -f /usr/share/doc/rsync/scripts/rrsync ]; then
    install -m0755 /usr/share/doc/rsync/scripts/rrsync /usr/local/bin/rrsync
    RRSYNC=/usr/local/bin/rrsync
  else
    err "rrsync not found — install rsync (apt-get install -y rsync) which provides it"
  fi
fi
log "using rrsync: $RRSYNC"

[ -d "$BACKUP_SRC" ] || err "BACKUP_SRC '$BACKUP_SRC' does not exist. Bind-mount the backups there first (see docs/onprem-pull-setup.md)."

# Backup user: system account, no sudo. Needs a real shell so the forced
# rrsync command can execute; the command= lock is what confines it.
if ! id -u "$BACKUP_USER" >/dev/null 2>&1; then
  log "creating user $BACKUP_USER (system, no sudo)"
  useradd --system --create-home --shell /bin/bash "$BACKUP_USER"
fi

# Grant read+traverse WITHOUT root, via POSIX ACLs; default ACL so each night's
# freshly-written backups inherit read access too.
command -v setfacl >/dev/null 2>&1 || { log "installing acl..."; apt-get update -y >/dev/null 2>&1 || true; apt-get install -y acl >/dev/null 2>&1 || err "please install the 'acl' package"; }
log "granting read ACLs on $BACKUP_SRC to $BACKUP_USER"
setfacl -R    -m "u:${BACKUP_USER}:rX" "$BACKUP_SRC"
setfacl -R -d -m "u:${BACKUP_USER}:rX" "$BACKUP_SRC"

# Command-locked, source-pinned authorized_keys entry.
home="$(getent passwd "$BACKUP_USER" | cut -d: -f6)"
install -d -m 0700 -o "$BACKUP_USER" -g "$BACKUP_USER" "$home/.ssh"
ak="$home/.ssh/authorized_keys"
pub="$(cat "$ONPREM_PUBKEY")"
keyfield="$(printf '%s' "$pub" | awk '{print $2}')"
line="command=\"${RRSYNC} -ro ${BACKUP_SRC}\",restrict,from=\"${ONPREM_IP}\" ${pub}"
touch "$ak"
grep -v -F "$keyfield" "$ak" > "$ak.tmp" 2>/dev/null || true; mv "$ak.tmp" "$ak"   # de-dupe
printf '%s\n' "$line" >> "$ak"
chown "$BACKUP_USER:$BACKUP_USER" "$ak"; chmod 0600 "$ak"
log "installed command-locked key: rrsync -ro (read-only), restrict, from=${ONPREM_IP}"

# Firewall: ADD a source-pinned SSH allow for the on-prem box. Does NOT remove
# the general SSH rule (that would risk locking admins out).
if [ "$PIN_UFW" = "true" ] && command -v ufw >/dev/null 2>&1; then
  log "adding UFW allow ${SSH_PORT}/tcp from ${ONPREM_IP}"
  ufw allow from "$ONPREM_IP" to any port "$SSH_PORT" proto tcp comment 'onprem backup pull' || true
  log "NOTE: general SSH rule left intact. Tighten it separately once all admins are on pinned sources."
fi

cat <<EOF

Done. Verify from the ON-PREM box (should list files, and refuse anything else):
  rsync -az --dry-run -e "ssh -i <key>" ${BACKUP_USER}@<server-ip>: /tmp/rs-test/
  ssh -i <key> ${BACKUP_USER}@<server-ip> 'echo hi'   # <- must FAIL (command-locked)
EOF
