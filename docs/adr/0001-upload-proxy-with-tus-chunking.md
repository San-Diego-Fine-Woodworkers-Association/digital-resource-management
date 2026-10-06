# A small proxy fronts member uploads; the browser never holds ResourceSpace credentials

ResourceSpace's API writes need a signed per-user key, so a static single-page app cannot talk to it safely, and ResourceSpace has no chunked or resumable upload API (a single request is capped at 100 MB by PHP and 60 seconds by Traefik's read timeout). We run one small Node container at `media.sdfwa.org/upload` that serves the React app and a narrow API, validates the SDFWA session itself, and holds a least-privilege ResourceSpace key. The browser sends each file to the proxy in chunks using the standard **tus** protocol (Uppy's `@uppy/tus` client, `@tus/server` in the proxy); the proxy assembles the file and makes one multipart POST to ResourceSpace directly over the Docker network, with PHP's upload limits raised to cover a 1 GB video.

## Considered options

- **A pure static app** (no server): rejected, there is nowhere safe to keep the key.
- **One request per file:** rejected, videos over roughly 35 MB cannot finish within Traefik's 60-second read timeout on a phone connection.
- **A custom chunk protocol:** rejected, tus already provides chunking, retry, resume after a dropped connection, a server-set maximum size, server-generated upload IDs and expiry cleanup.

## Consequences

The proxy is Node (not Bun). It sits on `dokploy-network` and `frontend` only, so it cannot reach MariaDB. It is a new service to build, deploy and keep patched.

Decided in: [Decide: Upload proxy shape and routing at media.sdfwa.org/upload](https://github.com/San-Diego-Fine-Woodworkers-Association/digital-resource-management/issues/17), [Decide: Uppy or a custom uploader on the design system](https://github.com/San-Diego-Fine-Woodworkers-Association/digital-resource-management/issues/20).
