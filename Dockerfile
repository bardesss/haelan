# syntax=docker/dockerfile:1

# Debian slim rather than Alpine, deliberately: @node-rs/argon2 publishes glibc prebuilds and no
# musl ones, so Alpine would fall back to compiling from source and put python3 and a C++ toolchain
# in this image permanently. Note that better-sqlite3 is no longer a reason for this: since v13 it
# ships musl prebuilds too. argon2 alone still decides it, so check that one before revisiting.
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
# autoInstallPeers=false here only: pnpm was filling peer slots for i18next/react-i18next and
# drizzle-orm with typescript and @types/* packages, which then rode --prod into this stage since
# a peer dependency isn't a dev dependency pnpm knows to drop. The build stage still needs the
# full peer graph to run `pnpm build`, so this flag is not set there.
#
# --frozen-lockfile refuses to run at all here: it also checks the "settings" pnpm recorded in
# the lockfile against the settings this install would use, and autoInstallPeers is one of them,
# so overriding it always trips ERR_PNPM_LOCKFILE_CONFIG_MISMATCH before installing a single
# package. --no-frozen-lockfile still resolves every package from the committed lockfile, since
# none of the versions or manifests changed; the only thing that changes is that the peer-filled
# entries are no longer added.
#
# The guarantee that flag usually carries is not lost, because the build stage above installs the
# same lockfile and the same manifests with --frozen-lockfile. A lockfile that had drifted from a
# manifest would fail there, in this same build, so no image can be produced from a mismatched
# pair whatever this line says.
# --filter @haelan/server... (the trailing ... pulls in its dependencies, i.e. @haelan/core) is
# what keeps this install to the server's production graph. Without it, a workspace-wide install
# has no way to know apps/web's react/echarts/i18next/etc are dead weight here: vite already
# bundled them into apps/web/dist, and nothing in the runtime image ever imports them again.
RUN pnpm install --filter @haelan/server... --no-frozen-lockfile --prod --config.autoInstallPeers=false

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
#
# /app used to be chowned to node too, which meant the process could rewrite its own source
# (proved: `touch apps/server/src/index.ts` succeeded as node). /app only needs to be readable,
# not writable, by the user the process runs as, and files COPYed in as root are already
# world-readable, so leaving /app root-owned costs nothing.
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 4235

# The same route the boot check uses, and for the same reason: it reads accounts, settings and
# credentials, so answering proves the database opened rather than only that a process is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4235/api/setup/state').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/src/index.ts"]
