# Staged uploads live on their own 50 GB volume, never on the root disk or the media volume

The proxy writes untrusted members' files to disk before ResourceSpace sees them. Staging gets a dedicated 50 GB Hetzner Volume, mounted `noexec,nosuid,nodev` and used for nothing else, with the proxy capping itself at 80% and checking free space before accepting each chunk. If staging ever fills, only staging stops: the 1 TB volume holding the database, filestore and backups, and the root disk that Dokploy and every other stack runs on, are untouched. Per-user limits (at most 2 uploads in flight and 4 GB staged, 10 GB and 100 Items per day) and a 24-hour sweep of abandoned uploads sit on top.

## Considered options

- **Staging on the root disk with only a proxy-enforced cap:** rejected, a bug could fill the disk the whole host depends on.
- **A fixed-size file system image on the root disk:** a workable alternative with no extra cost, but needs host setup.
- **A folder on the existing 1 TB volume:** rejected, filling it would break the database, filestore and backups.

## Consequences

A second Hetzner Volume to attach, format and mount before first use (see the host setup runbook).

Decided in: [Decide: Hardening the upload proxy against untrusted files and disk exhaustion](https://github.com/San-Diego-Fine-Woodworkers-Association/digital-resource-management/issues/23).
