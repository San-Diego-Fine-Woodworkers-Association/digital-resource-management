# Runbook: staging is full

The upload service stops taking chunks when the staging volume reaches its cap
(80%) or runs out of free space. Background:
[the staging volume](../upload-service.md#the-staging-volume).

```sh
HOST=root@5.78.204.140   # the production host, see docs/host-setup.md
```

## Symptoms

- Members sending see "We're busy right now", and their page keeps retrying.
- `https://media.sdfwa.org/upload/health` answers **503** with
  `"staging": {"ok": false, …}`: either `usedPercent` at or above
  `capPercent`, or `"writable": false`.
- Audit lines with `"outcome":"busy"` in the log.

## Check

**1. What does health say?**

```sh
curl -s https://media.sdfwa.org/upload/health
```

- `"writable": false` → the volume is probably **not mounted** (after a reboot:
  it is `nofail`) or has the wrong owner. Go to step 2.
- `usedPercent` ≥ `capPercent` → it really is full. Go to step 3.

**2. Is the volume mounted, and owned by 10001?**

```sh
HOST_SSH=$HOST scripts/host-setup.sh check
ssh $HOST 'findmnt /mnt/upload-staging; ls -ld /mnt/upload-staging'
```

Expect `/mnt/upload-staging` on an ext4 device with
`noexec,nosuid,nodev`, owned by `10001 10001`.

**3. What is on it?**

```sh
ssh $HOST 'df -h /mnt/upload-staging'
ssh $HOST 'ls -la --time-style=long-iso /mnt/upload-staging | sort -k6,7 | tail -40'
ssh $HOST 'find /mnt/upload-staging -maxdepth 1 -type f -regextype posix-extended -regex ".*/[0-9a-f]{32}" -printf "%TY-%Tm-%Td %TH:%TM  %s  %f\n" | sort'
```

The last command lists the uploads themselves (32 hex characters, no
extension) with their last change and size. File names are explained in
[What is on it](../upload-service.md#what-is-on-it).

- **Files changed in the last 24 hours** are uploads in progress, or ones that
  failed to hand over and can still be tried again. The sweep keeps them on
  purpose.
- **Files older than 24 hours** should not be there: the sweep runs every
  hour. Check it is running:

  ```sh
  ssh $HOST 'docker logs --since 3h $(docker ps -q --filter label=com.docker.compose.service=upload) 2>&1' | grep -E 'staging sweep|could not clean up'
  ```

- **Files with other names** are not the service's. The sweep never touches
  them. Find out who put them there.

**4. Is something stuck?** Uploads piling up because they can't be handed over
usually means ResourceSpace is failing:

```sh
ssh $HOST 'docker logs --since 6h $(docker ps -q --filter label=com.docker.compose.service=upload) 2>&1' | grep -E 'could not save to ResourceSpace|"outcome":"not_saved"' | tail
```

If so, see [ResourceSpace is down](resourcespace-down.md).

## Fix

**Not mounted:** mount it and check the owner, then restart the service so it
sees the volume:

```sh
ssh $HOST 'mount /mnt/upload-staging && chown 10001:10001 /mnt/upload-staging && findmnt /mnt/upload-staging'
```

Then redeploy the stack from Dokploy (or `ssh $HOST 'docker restart $(docker
ps -q --filter label=com.docker.compose.service=upload)'`). If the mount
fails, rerun the setup step in [host-setup.md](../host-setup.md#staging-volume);
it keeps an existing file system unless `STAGING_FORCE=1`.

**Full with real uploads:** this is the cap doing its job. Uploads leave
staging as they are handed over, so it usually drains by itself within minutes.

- To stop new uploads while it drains, turn on the
  [kill switch](../upload-service.md#uploads_paused-stop-taking-uploads)
  `UPLOADS_PAUSED=true` and redeploy. Turn it off again afterwards.
- If ResourceSpace is the reason nothing drains, fix that first:
  [ResourceSpace is down](resourcespace-down.md).
- If it fills often with legitimate uploads, the volume is too small. Grow the
  Hetzner Volume in the Cloud Console, then grow the file system on the host
  (`resize2fs` on the volume's device, online for ext4). This is not scripted;
  plan it. Don't raise `STAGING_CAP_PERCENT` instead: the 20% headroom covers
  chunks checked at the same moment.

**Full with abandoned files the sweep should have removed:** restart the
service. The startup sweep runs at once and logs `staging sweep`. If files over
24 hours old are still there afterwards, the service's sweep is failing:
read the log for `staging sweep failed` and `could not clean up staging at
startup`.

**Last resort, removing an upload by hand.** Only for an upload more than 24
hours old that the sweep has not removed. Remove all of its files together,
`<id>`, `<id>.json` and `<id>.item.json`, never one alone. If its
`<id>.item.json` has a `ref`, that Item is in Pending Review without everything:
tell a Reviewer the ref. Restart the service afterwards so it recounts what is
on staging. Never remove files changed in the last 24 hours: that is a
member's work in progress.

## Verify

```sh
curl -s https://media.sdfwa.org/upload/health
```

Expect **200**, `"status":"ok"`, `"writable": true` and `usedPercent` well
below `capPercent`. Then send one photo through `/upload` and check it reaches
Pending Review.
