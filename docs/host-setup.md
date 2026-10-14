# Host setup for Member Media Upload

One-time setup outside the code (#35): the staging volume and the outbound mail
path for reviewer notifications. `scripts/host-setup.sh` does the host side and
runs locally or over SSH (`HOST_SSH=root@<host>`). Background: ADR 0004 (staging
volume) and ADR 0006 (Workspace SMTP relay).

## Check the host (read-only)

```sh
HOST_SSH=root@5.78.204.140 scripts/host-setup.sh check
```

Prints the public IPs to allow on the relay, the attached Hetzner Volumes, the
fstab, whether staging is mounted, and whether outbound ports 587/465/25 reach
the relay. Hetzner Cloud blocks 25 and 465; 587 is what we use.

## Staging volume

Attach a 50 GB Hetzner Volume to the server. Hetzner's "automount" option is
fine: the script takes over the empty `/mnt/HC_Volume_<id>` mount. Then:

```sh
HOST_SSH=root@5.78.204.140 scripts/host-setup.sh staging /dev/disk/by-id/scsi-0HC_Volume_<id>
```

It formats the volume only if it is blank (`STAGING_FORCE=1` to reformat),
mounts it at `/mnt/upload-staging` with `noexec,nosuid,nodev,nofail,discard`
through fstab, gives it to UID/GID 10001 (the upload service's non-root user;
override with `STAGING_UID`/`STAGING_GID`), and proves the result: writable by
that user, executables refused. Set `UPLOAD_STAGING_PATH=/mnt/upload-staging`
in Dokploy. Like the media volume, it is `nofail`: check it is mounted after a
reboot.

## Reviewer notification mail

Google Workspace admin console, Apps > Google Workspace > Gmail > Routing >
SMTP relay service, add a setting:

- Allowed senders: only addresses in my domains
- Authentication: only accept mail from the specified IP addresses, the
  server's public IPv4 and IPv6 from `check`; no SMTP authentication
- Encryption: require TLS

The service sends as `no-reply@sdfwa.org` through `smtp-relay.gmail.com:587`
with STARTTLS and EHLO `media.sdfwa.org`. The reviewers' Group
`media-reviewers@sdfwa.org` must allow posting from `no-reply@sdfwa.org`
(Groups > Settings > Who can post: anyone on the web, or add the address as a
member that can post).

SPF for `sdfwa.org` includes `_spf.google.com` and Google DKIM is published, so
relayed mail passes both.

Test from the server:

```sh
HOST_SSH=root@5.78.204.140 scripts/host-setup.sh mail-test media-reviewers@sdfwa.org
```

The script prints the SMTP conversation. Confirm that every Group member gets
the message and that it is not in spam.

The upload service sends the Reviewers' email (#61) with these Dokploy
environment variables; the defaults are the values above, so none needs
setting: `SMTP_HOST`, `SMTP_PORT`, `SMTP_EHLO_NAME`, `REVIEWER_EMAIL_FROM`,
`REVIEWER_EMAIL_TO`, `REVIEWER_EMAIL_STALL_MINUTES` (30), and the kill
switch `REVIEWER_EMAIL_PAUSED` (anything but false/0/no/off sends nothing).
Each attempt, and each send given up on, is in the container log: look for
`"event":"reviewer_email"` and `could not send the reviewer email`.

Trade-off: the relay trusts the server's IP, so any container on this host can
send as an `@sdfwa.org` address. Accepted in ADR 0006.
