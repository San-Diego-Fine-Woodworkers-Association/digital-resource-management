FROM python:3.12-slim

LABEL org.opencontainers.image.authors="SDFWA Digital Services"

ENV DEBIAN_FRONTEND="noninteractive" \
    PIP_NO_CACHE_DIR=1

# subversion to export the plugin scripts; build tooling because insightface
# compiles native extensions during install. insightface pulls in the full
# opencv-python (not headless), whose cv2 extension links libGL / libxcb / libX*
# at import time, so those runtime libs must be present on this slim base.
RUN apt-get update && apt-get install -y --no-install-recommends \
    subversion \
    build-essential \
    cmake \
    libgl1 \
    libglib2.0-0 \
    libxcb1 \
    libxext6 \
    libxrender1 \
    libsm6 \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# CPU-only face-recognition stack (see the AI Faces knowledge-base article).
COPY requirements.txt /tmp/requirements.txt
RUN pip install -r /tmp/requirements.txt

WORKDIR /app

# Keep the service script in lockstep with RS core. Pinned to the revision the
# core image is built from (keep in sync with the Dockerfile svn checkout).
RUN svn export -q -r 29265 https://svn.resourcespace.com/svn/rs/releases/11.0/plugins/faces/scripts /app/scripts

# faces_service.py binds uvicorn to 127.0.0.1; in a container it must listen on
# all interfaces so the resourcespace service can reach it. Fail the build if the
# expected line is gone rather than shipping an unreachable service.
RUN sed -i 's/host="127.0.0.1"/host="0.0.0.0"/' /app/scripts/faces_service.py \
 && grep -q 'host="0.0.0.0"' /app/scripts/faces_service.py

# The buffalo_l model downloads here on first run; mount a volume to persist it.
ENV INSIGHTFACE_HOME=/root/.insightface

WORKDIR /app/scripts

# DB credentials come from FACES_DB_HOST / FACES_DB_USER / FACES_DB_PASS env vars.
CMD ["python", "faces_service.py", "--port", "8001"]
