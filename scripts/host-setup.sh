#!/usr/bin/env bash
# One-time host setup for Member Media Upload (#35), run on the Docker host
# itself or on a remote one over SSH. See docs/host-setup.md.
#
# Usage:
#   scripts/host-setup.sh check
#       Read-only: public IP, disks, mounts, outbound SMTP ports, DNS mail records.
#   scripts/host-setup.sh staging <device>
#       Format (only if blank) and mount the dedicated staging volume at
#       $STAGING_MOUNT with noexec,nosuid,nodev, owned by $STAGING_UID:$STAGING_GID.
#       <device> is the volume's /dev/disk/by-id/scsi-0HC_Volume_<id> path.
#   scripts/host-setup.sh mail-test <to-address>
#       Send one message from $MAIL_FROM through the Google Workspace SMTP relay.
#
# Environment:
#   HOST_SSH=user@host   run against a remote host (default: this machine)
#   STAGING_MOUNT=path   default /mnt/upload-staging (becomes UPLOAD_STAGING_PATH)
#   STAGING_UID/GID      default 10001/10001 (the upload service's non-root user)
#   STAGING_FORCE=1      staging: format even if the device already has a file system
#   MAIL_FROM=address    default no-reply@sdfwa.org
#   SMTP_RELAY=host:port default smtp-relay.gmail.com:587
set -euo pipefail

if [ -n "${HOST_SSH:-}" ]; then
    # Re-run this same script on the remote host, passing settings and arguments through.
    envs=()
    for v in STAGING_MOUNT STAGING_UID STAGING_GID STAGING_FORCE MAIL_FROM SMTP_RELAY; do
        if [ -n "${!v:-}" ]; then envs+=("$v=${!v}"); fi
    done
    exec ssh "$HOST_SSH" "$(printf '%q ' env ${envs[@]+"${envs[@]}"} bash -s -- "$@")" < "$0"
fi

STAGING_MOUNT="${STAGING_MOUNT:-/mnt/upload-staging}"
STAGING_UID="${STAGING_UID:-10001}"
STAGING_GID="${STAGING_GID:-10001}"
MAIL_FROM="${MAIL_FROM:-no-reply@sdfwa.org}"
SMTP_RELAY="${SMTP_RELAY:-smtp-relay.gmail.com:587}"

port_open() { timeout 8 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; }

cmd_check() {
    echo "== Host: $(hostname)"
    echo "== Public IPv4 (allow this on the Workspace SMTP relay)"
    curl -s4 --max-time 10 https://ifconfig.me || echo "(lookup failed)"
    echo
    echo "== Public IPv6"
    curl -s6 --max-time 10 https://ifconfig.me || echo "(none)"
    echo
    echo "== Block devices"
    lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT,SERIAL
    echo "== Hetzner volumes"
    ls -l /dev/disk/by-id/ | grep HC_Volume || echo "(none)"
    echo "== fstab"
    grep -v '^\s*#' /etc/fstab | grep .
    echo "== Staging mount ($STAGING_MOUNT)"
    findmnt "$STAGING_MOUNT" || echo "(not mounted)"
    echo "== Outbound SMTP"
    local host="${SMTP_RELAY%:*}"
    for p in 587 465 25; do
        if port_open "$host" "$p"; then echo "$host:$p open"; else echo "$host:$p BLOCKED"; fi
    done
    echo "== Tools"
    for t in python3 mkfs.ext4 curl dig; do printf '%s: %s\n' "$t" "$(command -v "$t" || echo missing)"; done
}

cmd_staging() {
    local dev="${1:?usage: staging /dev/disk/by-id/scsi-0HC_Volume_<id>}"
    [ "$(id -u)" = 0 ] || { echo "staging must run as root" >&2; exit 1; }
    [ -b "$dev" ] || { echo "$dev is not a block device" >&2; exit 1; }
    case "$dev" in /dev/disk/by-id/*) ;; *) echo "use the stable /dev/disk/by-id/ path, not $dev" >&2; exit 1 ;; esac

    local real; real="$(readlink -f "$dev")"
    # Refuse to touch anything that is already in use: the media volume, root, etc.
    if findmnt -rn -S "$real" >/dev/null; then
        local at; at="$(findmnt -rn -S "$real" -o TARGET)"
        if [ "$at" != "$STAGING_MOUNT" ]; then
            # Hetzner's "automount" option mounts a new volume at /mnt/HC_Volume_<id>
            # without our options. Take it over only if it is still empty.
            case "$at" in
                /mnt/HC_Volume_*)
                    if [ -n "$(find "$at" -mindepth 1 -maxdepth 1 ! -name lost+found -print -quit)" ]; then
                        echo "$dev is mounted at $at and not empty; refusing" >&2
                        exit 1
                    fi
                    echo "Taking over Hetzner auto-mount at $at (empty)"
                    umount "$at"
                    cp /etc/fstab "/etc/fstab.bak.$(date +%Y%m%d%H%M%S)"
                    grep -vF "$dev " /etc/fstab > /etc/fstab.new || true
                    mv /etc/fstab.new /etc/fstab
                    rmdir "$at"
                    ;;
                *)
                    echo "$dev is mounted at $at; refusing" >&2
                    exit 1
                    ;;
            esac
        fi
    fi

    local fstype; fstype="$(blkid -o value -s TYPE "$real" || true)"
    if [ -z "$fstype" ]; then
        echo "Formatting $dev as ext4"
        mkfs.ext4 -q -L upload-staging "$real"
    elif [ "${STAGING_FORCE:-}" = 1 ]; then
        echo "STAGING_FORCE=1: reformatting $dev (was $fstype)"
        umount "$STAGING_MOUNT" 2>/dev/null || true
        mkfs.ext4 -q -F -L upload-staging "$real"
    else
        echo "$dev already has a $fstype file system; keeping it (STAGING_FORCE=1 to reformat)"
    fi

    local uuid; uuid="$(blkid -o value -s UUID "$real")"
    local line="UUID=$uuid $STAGING_MOUNT ext4 defaults,noexec,nosuid,nodev,nofail,discard 0 2"
    mkdir -p "$STAGING_MOUNT"
    cp /etc/fstab "/etc/fstab.bak.$(date +%Y%m%d%H%M%S)"
    # Replace any earlier line for this mount point or this file system.
    grep -vE "[[:space:]]$STAGING_MOUNT[[:space:]]|^UUID=$uuid[[:space:]]" /etc/fstab > /etc/fstab.new || true
    echo "$line" >> /etc/fstab.new
    mv /etc/fstab.new /etc/fstab
    systemctl daemon-reload
    if findmnt "$STAGING_MOUNT" >/dev/null; then
        mount -o remount "$STAGING_MOUNT"
    else
        mount "$STAGING_MOUNT"
    fi
    chown "$STAGING_UID:$STAGING_GID" "$STAGING_MOUNT"
    chmod 0750 "$STAGING_MOUNT"

    echo "== Result"
    findmnt -o TARGET,SOURCE,FSTYPE,OPTIONS "$STAGING_MOUNT"
    df -h "$STAGING_MOUNT"
    ls -ld "$STAGING_MOUNT"
    # Prove noexec and ownership as the container user would see them.
    local probe="$STAGING_MOUNT/.probe-$$"
    setpriv --reuid="$STAGING_UID" --regid="$STAGING_GID" --clear-groups \
        sh -c "printf '#!/bin/sh\necho ran\n' > '$probe' && chmod +x '$probe' && echo 'writable by $STAGING_UID: yes' && ('$probe' 2>/dev/null && echo 'noexec: NOT ENFORCED' || echo 'noexec: enforced')"
    rm -f "$probe"
    echo "Set UPLOAD_STAGING_PATH=$STAGING_MOUNT in Dokploy."
}

cmd_mail_test() {
    local to="${1:?usage: mail-test <to-address>}"
    MAIL_FROM="$MAIL_FROM" SMTP_RELAY="$SMTP_RELAY" MAIL_TO="$to" python3 - <<'PY'
import os, smtplib, socket, ssl, datetime
from email.message import EmailMessage
from email.utils import make_msgid, formatdate

host, port = os.environ["SMTP_RELAY"].rsplit(":", 1)
msg = EmailMessage()
msg["From"] = f"SDFWA Media <{os.environ['MAIL_FROM']}>"
msg["To"] = os.environ["MAIL_TO"]
msg["Subject"] = "Test: SDFWA Media upload notifications"
msg["Date"] = formatdate(localtime=True)
msg["Message-ID"] = make_msgid(domain="sdfwa.org")
msg.set_content(
    "This is a test of the reviewer notification path for member media uploads.\n"
    f"Sent from {socket.gethostname()} at {datetime.datetime.now().isoformat(timespec='seconds')}\n"
    "through the Google Workspace SMTP relay. No action needed.\n"
)
# The relay checks the EHLO name and the source IP; it never sees credentials.
with smtplib.SMTP(host, int(port), local_hostname="media.sdfwa.org", timeout=30) as s:
    s.set_debuglevel(1)
    s.starttls(context=ssl.create_default_context())
    s.ehlo("media.sdfwa.org")
    s.send_message(msg)
print(f"Accepted by {host}:{port} for {msg['To']}")
PY
}

case "${1:-}" in
    check) cmd_check ;;
    staging) shift; cmd_staging "$@" ;;
    mail-test) shift; cmd_mail_test "$@" ;;
    *) echo "usage: $0 check | staging <device> | mail-test <to-address>" >&2; exit 2 ;;
esac
