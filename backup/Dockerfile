# Backup sidecar for the ResourceSpace stack.
# Stages consistent, point-in-time backups onto the `backups` volume:
#   - a compressed logical dump of the MariaDB database (over the network)
#   - an incremental mirror of the rs_assets filestore (mounted read-only)
#   - (optional) an age-encrypted snapshot of the deployment secrets
# An off-site box then PULLS the `backups` volume over rsync/SSH.
# See docs/backups.md and docs/onprem-pull-setup.md.
FROM alpine:3.20

# mariadb-client -> mariadb-dump; rsync -> filestore mirror + on-prem pull;
# age -> optional secret encryption; coreutils/findutils -> stat/find -delete;
# tzdata -> TZ-aware cron; tini -> clean PID 1 / signal handling.
RUN apk add --no-cache \
    mariadb-client \
    rsync \
    gzip \
    age \
    coreutils \
    findutils \
    tzdata \
    tini

COPY backup.sh /usr/local/bin/backup.sh
COPY healthcheck.sh /usr/local/bin/healthcheck.sh
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/healthcheck.sh /usr/local/bin/entrypoint.sh

VOLUME ["/backups"]

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/usr/local/bin/entrypoint.sh"]
