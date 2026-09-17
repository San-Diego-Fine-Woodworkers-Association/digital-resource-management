# Storage Box Setup (off-site push target)

Provisions a Hetzner Storage Box as **copy 2** in the 3-2-1 scheme: the backup
sidecar pushes here nightly; the on-prem box then pulls from *here*, never
from the ResourceSpace server. See [backups.md](./backups.md) for the full
picture and [onprem-pull-setup.md](./onprem-pull-setup.md) for the pull side.

```
backup sidecar ──rsync push (RW sub-account, port 23)──►  Storage Box
                                                                │
                                          on-prem box ◄──rsync pull (RO sub-account)
```

Two sub-accounts, not one, mirroring the read-only-pull philosophy the old
direct-to-server design used — a leaked pull credential still can't write or
delete anything.

## 1. Order the box (Hetzner Robot)

Robot → Storage Box → order. Size for the filestore + DB dump + secrets you're
staging today, with headroom (retention keeps a rolling window, not one copy).

## 2. Enable SSH support

Robot → your Storage Box → **Settings** → enable **SSH support**. Without this,
only SFTP/WebDAV work — rsync needs it.

## 3. Enable automatic Snapshots

Robot → your Storage Box → **Snapshots** → turn on scheduled snapshots, daily,
keep as many slots as your plan allows.

**This is the compensating control for the push leg holding a write
credential.** Storage Box snapshots are managed by Hetzner outside the SSH
account entirely — a compromised RW credential can `rsync --delete` the live
tree, but it cannot touch a prior snapshot. Skipping this step means a leaked
push key can destroy your only off-site copy before the on-prem pull even
notices; do not skip it.

## 4. Create the two sub-accounts

Robot → your Storage Box → **Sub-accounts** → create:

| Sub-account | Access | Used by | Home directory |
| --- | --- | --- | --- |
| `push` | **read-write** | backup sidecar | e.g. `/resourcespace` |
| `pull` | **read-write, for now** (see step 6) | on-prem puller | same `/resourcespace` (or a sub-path of it) |

**Create `pull` as read-write too, initially.** Hetzner's read-only flag
appears to make the *entire* sub-account read-only, including its own
`.ssh/authorized_keys` — `install-ssh-key` fails to write it once RO is set
(`Could not append key ... in RFC4716 format`, confirmed by testing: an
identical key installs cleanly on the RW account and fails on the RO one).
The key has to go in before the account becomes read-only.

Note the generated usernames (`u123456-sub1`, `u123456-sub2` or similar) and
the box's hostname (`u123456.your-storagebox.de`) — you'll need both for every
step below.

## 5. Generate keys

One keypair per sub-account, generated where that credential will actually
live — **not** on a machine that holds both.

**Use RSA, not ed25519.** Hetzner's `install-ssh-key` stores each key in two
formats (OpenSSH for port 23, RFC4716 for port 22), and its ed25519→RFC4716
conversion is known-buggy — it fails with `Could not append key ... in
RFC4716 format to authorized_keys file`, even though the key itself is fine.
RSA has always worked with it.

```bash
# On (or for) the backup sidecar's host — this key ends up in a Dokploy secret:
ssh-keygen -t rsa -b 4096 -f ./storagebox_push -C "resourcespace-backup-push" -N ""

# On the on-prem box:
ssh-keygen -t rsa -b 4096 -f ~/.ssh/storagebox_pull -C "resourcespace-backup-pull" -N ""
```

## 6. Install each public key on its sub-account

Port 23 only accepts keys in old OpenSSH format (port 22 wants RFC4716 — use
23 for everything here, rsync needs it anyway):

```bash
# Push key -> push sub-account:
cat storagebox_push.pub | ssh -p23 <push-user>@<box-host> install-ssh-key

# Pull key -> pull sub-account, still read-write at this point (run from the on-prem box):
cat ~/.ssh/storagebox_pull.pub | ssh -p23 <pull-user>@<box-host> install-ssh-key
```

Watch for `... was installed in RFC4716 format` / `... was installed in
OpenSSH format` for **both** keys — that's success.

### Now flip `pull` to read-only

Robot → **Sub-accounts** → edit `pull` → toggle to **read-only** → save. This
is a one-time step per key: you only redo it if you ever rotate the pull key
(temporarily flip back to RW, reinstall, flip back to RO). Day-to-day pulls
never need it touched again.

**Verify the read-only flag actually took effect** — don't just trust the
toggle:
```bash
ssh -p23 -i ~/.ssh/storagebox_pull <pull-user>@<box-host> \
  'echo test > write-test.txt' && echo "!! WROTE — RO IS NOT ENFORCED, INVESTIGATE" \
  || echo "write refused — RO confirmed"
```
If that write succeeds, the account isn't actually read-only despite the
toggle, and this pull credential offers no more protection than the push
one — don't proceed to production until that's resolved with Hetzner
support or a different account configuration.

## 7. Pin the host key (both sides need this)

Unattended rsync should never TOFU-accept a host key. Capture it once, from a
trusted vantage point:

```bash
ssh-keyscan -p 23 -t ed25519 <box-host> > storagebox_known_hosts
cat storagebox_known_hosts   # this line is what STORAGE_BOX_HOST_KEY holds
```

Verify the fingerprint against Hetzner's published one for your box (Robot UI
shows it) before trusting this file — that's the whole point of pinning it.

## 8. Wire the push side into Dokploy

Dokploy's **Environment** tab parses one `KEY=VALUE` per line, the same as a
`.env` file — pasting a raw multi-line `-----BEGIN OPENSSH PRIVATE KEY-----`
block in directly will get split across "lines" and corrupted. Base64-encode
the private key to a single line first:

```bash
base64 -w0 storagebox_push > storagebox_push.b64   # -w0: no line wrapping
cat storagebox_push.b64                            # this is what you paste below
```
(macOS: `base64 -i storagebox_push -o storagebox_push.b64`, or `base64 storagebox_push | tr -d '\n'`.)

On the `digital-resource-management` stack's **Environment** in Dokploy, set:

```
STORAGE_BOX_HOST=<box-host>                # u123456.your-storagebox.de
STORAGE_BOX_USER=<push-user>               # the RW sub-account
STORAGE_BOX_PORT=23
STORAGE_BOX_REMOTE_PATH=./resourcespace/   # or wherever the RW sub-account is rooted
STORAGE_BOX_SSH_KEY_B64=<contents of storagebox_push.b64 — one long line>
STORAGE_BOX_HOST_KEY=<contents of storagebox_known_hosts from step 7 — already one line>
```

Redeploy. `entrypoint.sh` decodes the key, writes it + known_hosts to disk in
the container on every start; `backup.sh` pushes after staging + manifest on every
run, and only stamps `.backup-ok` once the push succeeds — see
[backups.md](./backups.md) for what that means for the healthcheck.

**Delete `storagebox_push` and `storagebox_push.b64` from your machine once
it's in Dokploy.** Neither should exist outside Dokploy and Bitwarden.

## 9. Verify the push

```bash
docker exec <backup-container> /usr/local/bin/backup.sh
docker exec <backup-container> sh -c 'cat /backups/manifest.txt'
```
Then confirm the pull sub-account can see what landed (its RO enforcement was
already verified at the end of step 6). Note this lists the `resourcespace`
subdirectory, **not** the account's bare root — a plain `ls` with no path
lands in the account's home, which contains `resourcespace/` alongside
`.ssh/`, not the backup files themselves:
```bash
ssh -p23 -i ~/.ssh/storagebox_pull <pull-user>@<box-host> ls resourcespace
```

## 10. Point the on-prem puller here

Continue with [onprem-pull-setup.md](./onprem-pull-setup.md) — `SERVER` is now
the **pull** sub-account/host, not the ResourceSpace server, and `REMOTE_PATH`
must be set to `resourcespace` (a real account's `/` is the actual filesystem
root, not the account's home — see that doc for why this bit).

## 11. Decommission the old direct-to-server access

If the on-prem box previously pulled straight from the ResourceSpace server
(`scripts/setup-onprem-pull.sh`, the `rsbackup` user), remove that once the
Storage Box path is verified working for a few nights:

```bash
# on the ResourceSpace server, as root:
userdel -r rsbackup
ufw status numbered   # find the 'onprem backup pull' rule, then:
ufw delete <rule-number>
```
The server no longer needs any inbound rule or account for backups at all —
it only makes an outbound connection to the Storage Box now.
