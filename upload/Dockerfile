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

# --- runtime dependencies: the tus server and nodemailer ----------------------
# The web app's libraries (React, Uppy, the design system) are bundled into
# dist/web at build time, so they are devDependencies and not installed here.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# --- runtime -----------------------------------------------------------------
# Node runs the server's TypeScript directly (built-in type stripping). Its
# only runtime dependencies are @tus/server and @tus/file-store (ADR 0001),
# and nodemailer for the Reviewers' email (ADR 0006).
FROM node:24-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    STAGING_DIR=/staging
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/shared ./shared
COPY --from=build /app/server ./server
COPY --from=build /app/dist/web ./dist/web

# A fixed non-root user. The staging volume on the host must be owned by this
# UID/GID (see issue #35). Compose adds a read-only root filesystem, dropped
# capabilities, no-new-privileges and resource limits.
USER 10001:10001
EXPOSE 8080
CMD ["node", "server/main.ts"]
