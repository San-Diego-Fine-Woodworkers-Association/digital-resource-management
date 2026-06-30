FROM python:3.12-slim

LABEL org.opencontainers.image.authors="SDFWA Digital Services"

ENV DEBIAN_FRONTEND="noninteractive" \
    PIP_NO_CACHE_DIR=1

# git is needed for the git+ CLIP install; subversion to export the plugin
# scripts at a version matched to RS core.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    subversion \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# CPU-only ML stack for the CLIP service (see plugins/clip/readme.txt).
COPY requirements.txt /tmp/requirements.txt
RUN pip install -r /tmp/requirements.txt

WORKDIR /app

# Pull the CLIP service script from the same RS release as the core image so the
# service stays in lockstep with the plugin. Pinned to the revision the core
# image is built from (keep in sync with the Dockerfile svn checkout).
RUN svn export -q -r 29265 https://svn.resourcespace.com/svn/rs/releases/11.0/plugins/clip/scripts /app/scripts

# clip_service.py hardcodes the MySQL host to "localhost"; in a separate
# container the database lives in the "mariadb" service, so make the host honor
# the CLIP_DB_HOST environment variable. Fail the build if the expected line is
# gone (upstream changed it) rather than shipping a service that can't reach the DB.
RUN sed -i 's/"host": "localhost"/"host": os.environ.get("CLIP_DB_HOST", "localhost")/' /app/scripts/clip_service.py \
 && grep -q 'os.environ.get("CLIP_DB_HOST"' /app/scripts/clip_service.py

# The CLIP model downloads to ~/.cache/clip and torch.hub to ~/.cache/torch;
# mount the clip_cache volume at /root/.cache to persist both across rebuilds.

WORKDIR /app/scripts

# Credentials are supplied via CLIP_DB_USER / CLIP_DB_PASS env vars (read by the
# script before falling back to args/prompt).
CMD ["python", "clip_service.py", "--host", "0.0.0.0", "--port", "8000"]
