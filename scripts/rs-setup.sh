#!/usr/bin/env bash
# Run one of the scripts/rs-setup/*.php scripts inside the running ResourceSpace
# container, on this machine or on a remote Docker host over SSH. Works with any
# compose project name (local `docker compose`, Dokploy, ...). See
# docs/resourcespace-setup.md.
#
# Usage: scripts/rs-setup.sh provision|verify
#
# Environment:
#   RS_SSH=user@host     run against a remote Docker host (default: local docker)
#   RS_CONTAINER=name    container to use (default: the one compose service "resourcespace")
#   RS_PRINT_API_KEY=1   provision: print upload-service's API key (local development only)
#   RS_TEST_BASEURL=url  verify: URL the container uses to reach ResourceSpace (default: $baseurl)
#   RS_TEST_PRUNE=1      verify: also drop each permission in turn and report which are needed
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
case "${1:-}" in
    provision) script="$here/rs-setup/provision.php" ;;
    verify) script="$here/rs-setup/verify-permissions.php" ;;
    *) echo "usage: $0 provision|verify" >&2; exit 2 ;;
esac

run() {
    if [ -n "${RS_SSH:-}" ]; then
        ssh "$RS_SSH" "$(printf '%q ' "$@")"
    else
        "$@"
    fi
}

cid="${RS_CONTAINER:-}"
if [ -z "$cid" ]; then
    cids="$(run docker ps -q --filter label=com.docker.compose.service=resourcespace)"
    if [ "$(printf '%s\n' "$cids" | grep -c .)" -ne 1 ]; then
        echo "expected exactly one running 'resourcespace' container, found:" >&2
        run docker ps --filter label=com.docker.compose.service=resourcespace --format '  {{.Names}}' >&2
        echo "set RS_CONTAINER to choose one" >&2
        exit 1
    fi
    cid="$cids"
fi

envs=()
for v in RS_PRINT_API_KEY RS_TEST_BASEURL RS_TEST_PRUNE; do
    if [ -n "${!v:-}" ]; then
        envs+=(-e "$v=${!v}")
    fi
done

echo "Running $(basename "$script") in container $cid${RS_SSH:+ on $RS_SSH}" >&2
# `php` with no file argument reads the script from stdin.
# ${envs[@]+...}: an empty array is "unbound" under set -u on bash < 4.4 (macOS)
run docker exec -i -u www-data ${envs[@]+"${envs[@]}"} "$cid" php < "$script"
