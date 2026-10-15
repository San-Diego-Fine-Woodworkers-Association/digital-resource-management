# Runbook: ResourceSpace is down

The upload service hands every Item to ResourceSpace. While ResourceSpace does
not answer, the service takes no new Submissions or uploads; what is already on
staging waits there.

```sh
HOST=root@<server IP>   # the server's public IPv4 or IPv6: Hetzner Cloud console, under the project's server
```

## Symptoms

- `https://media.sdfwa.org` itself is down or shows an error.
- Members opening `/upload` see "We're busy right now" (503). A page already
  sending keeps retrying, then shows Couldn't save or Waiting for your
  connection.
- `https://media.sdfwa.org/upload/health` answers **503** with
  `"resourcespace": {"reachable": false, …}`.
- In the upload log: `"outcome":"rs_unreachable"`, `could not save to
  ResourceSpace`, `ResourceSpace failed during a hand-off; trying again`.

A variant: **ResourceSpace is up but refuses the upload service** (the API key
is wrong). Health shows `reachable: true`, but every hand-off fails with
`could not save to ResourceSpace`. See [Fix](#fix), last case.

## Check

**1. From outside.**

```sh
curl -sI https://media.sdfwa.org/ | head -1
curl -s https://media.sdfwa.org/upload/health
```

**2. Are the containers running?**

```sh
for s in resourcespace mariadb upload; do
  ssh $HOST "docker ps -a --filter label=com.docker.compose.service=$s --format '{{.Names}}\t{{.Status}}'"
done
```

`Exited` or `Restarting` is the answer. Read that container's log:

```sh
ssh $HOST 'docker logs --tail 100 $(docker ps -aq --filter label=com.docker.compose.service=resourcespace) 2>&1'
ssh $HOST 'docker logs --tail 100 $(docker ps -aq --filter label=com.docker.compose.service=mariadb) 2>&1'
```

**3. Did the host run out of memory?** The 2026-10-05 failures were the kernel
killing processes when the host ran out of memory.

```sh
ssh $HOST 'free -h; journalctl -k --since "-1 day" | grep -i "killed process"'
```

**4. Is the data volume mounted?** The database, filestore and backups live on
a Hetzner Volume mounted `nofail`, so after a reboot it may be missing.

```sh
HOST_SSH=$HOST scripts/host-setup.sh check
```

Look for the data volume in "Block devices" and "fstab". Its mount point is
`DATA_VOLUME_PATH` in Dokploy: `/mnt/HC_Volume_105523521` on production
(checked 2026-10-15), holding `filestore/`, `mariadb/` and `backups/`.

```sh
ssh $HOST 'findmnt /mnt/HC_Volume_105523521; df -h /mnt/HC_Volume_105523521'
```

**5. Is the root disk full?**

```sh
ssh $HOST 'df -h /'
```

## Fix

**A container stopped or is crash-looping:** redeploy the stack from Dokploy,
or restart just that container:

```sh
ssh $HOST 'docker restart $(docker ps -aq --filter label=com.docker.compose.service=resourcespace)'
```

If MariaDB will not start and its log points to damaged data, stop and follow
[restore.md](../restore.md).

**Out of memory:** restart what was killed (above). The `clip` and `faces`
containers have hard memory caps so they can't starve ResourceSpace again; if
it recurs, read `free -h` and `docker stats --no-stream` on the host and raise
it on the issue tracker.

**Data volume not mounted:** mount it, then redeploy the stack so every
container sees the real data rather than an empty directory:

```sh
ssh $HOST 'mount -a && findmnt /mnt/HC_Volume_105523521'
```

**Root disk full:** find what grew (`du -xsh /var/lib/docker/* | sort -h`).
Container logs are capped only for the `upload` service.

**ResourceSpace up, but the upload service's key is refused.** This happens
when the `upload-service` user was recreated or `API_SCRAMBLE_KEY` changed:

1. Check the user and its permissions:
   `RS_SSH=$HOST scripts/rs-setup.sh verify`
   ([resourcespace-setup.md](../resourcespace-setup.md)).
2. Copy the key from Admin > Users > upload-service into the Dokploy secret
   `RS_UPLOADER_API_KEY`, and redeploy.

**What happens to members' uploads.** Files already on staging wait there for
24 hours from their last activity. A member whose page is still open can press
**Try again** once ResourceSpace is back, and the hand-off reuses the same
Item. A member who closed the page has to choose those photos again. The
Reviewers' email for a Submission that stalled during the outage goes as
partial after 30 minutes, listing only what arrived.

## Verify

```sh
curl -sI https://media.sdfwa.org/ | head -1
curl -s https://media.sdfwa.org/upload/health
```

Expect ResourceSpace's front page to answer (200 or a redirect to sign in), and
health to answer **200** with `"reachable": true` and `"configured": true`.
Health remembers a failure for 5 seconds, so it recovers almost at once. Then
send one photo through `/upload` and check it reaches Pending Review.
