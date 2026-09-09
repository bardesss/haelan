# syntax=docker/dockerfile:1

# Debian slim rather than Alpine, deliberately: better-sqlite3 and @node-rs/argon2 publish glibc
# prebuilds and no musl ones, so Alpine would fall back to compiling from source and put python3
# and a C++ toolchain in this image permanently.
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable

# Manifests first, so a source-only change does not re-resolve the dependency graph.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/tokens/package.json packages/tokens/
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile

COPY . .
# Generates the token stylesheet through its prebuild hook, then emits apps/web/dist.
RUN pnpm build

# A second install into a clean tree, production only. Cheaper and far more predictable than
# pruning the first one, and it is what decides the size of the shipped image.
FROM node:24-slim AS deps
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/tokens/package.json packages/tokens/
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --prod

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# The layout is load-bearing, not tidiness: migrate.ts reads ../../drizzle relative to its own
# file and index.ts serves ../../web/dist relative to its own, so both paths only resolve if the
# workspace shape survives into the image.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=deps /app/apps/server/node_modules ./apps/server/node_modules
COPY pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY packages/core/src packages/core/src
COPY packages/core/drizzle packages/core/drizzle
COPY apps/server/package.json apps/server/
COPY apps/server/src apps/server/src
COPY --from=build /app/apps/web/dist apps/web/dist

# node:24-slim ships an unprivileged `node` user. /data is the only path the process writes, and
# it is a volume, so its ownership has to be set before the volume is declared.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 4235

# The same route the boot check uses, and for the same reason: it reads accounts, settings and
# credentials, so answering proves the database opened rather than only that a process is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4235/api/setup/state').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/src/index.ts"]
