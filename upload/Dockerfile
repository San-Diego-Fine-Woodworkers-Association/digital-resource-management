# The Member Media Upload service (issue #33): serves the page at
# media.sdfwa.org/upload and its narrow API. See docs/adr/0001.

# --- build: the web app ------------------------------------------------------
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build \
 && find server -name '*.test.ts' -delete \
 && rm -rf server/testing

# --- runtime -----------------------------------------------------------------
# No node_modules: the server uses only Node's standard library and runs its
# TypeScript directly (Node's built-in type stripping).
FROM node:24-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    STAGING_DIR=/staging
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/shared ./shared
COPY --from=build /app/server ./server
COPY --from=build /app/dist/web ./dist/web

# A fixed non-root user. The staging volume on the host must be owned by this
# UID/GID (see issue #35). Compose adds a read-only root filesystem, dropped
# capabilities, no-new-privileges and resource limits.
USER 10001:10001
EXPOSE 8080
CMD ["node", "server/main.ts"]
