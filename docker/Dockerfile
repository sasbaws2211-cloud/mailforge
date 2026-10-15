# Stage 1: Builder - installs all deps (including devDeps) and builds dist files.
FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/adapters/package.json packages/adapters/
COPY packages/api/package.json packages/api/
COPY packages/worker/package.json packages/worker/
COPY packages/scheduler/package.json packages/scheduler/
COPY packages/brain-oss/package.json packages/brain-oss/
COPY apps/server/package.json apps/server/
COPY apps/dashboard/package.json apps/dashboard/
# drizzle/ is workspace package @loomail/db; package.json required for pnpm install
COPY drizzle/package.json drizzle/

RUN pnpm install --frozen-lockfile

# Copy source
COPY tsconfig.base.json turbo.json ./
COPY packages/ packages/
COPY apps/ apps/

COPY drizzle/ drizzle/

RUN pnpm install --frozen-lockfile

RUN find . -name 'tsconfig.tsbuildinfo' -not -path '*/node_modules/*' -delete

RUN pnpm build

# Stage 2: Dev - keeps all deps (including tsx) for hot reload.
# docker-compose.yml mounts the source over /app so file changes are visible
# immediately; node_modules stays from this image layer (Linux binaries).
# FROM node:22-alpine AS dev

# RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# WORKDIR /app

# # All deps including devDeps (tsx, vitest, etc.) - needed for `tsx watch`.
# COPY --from=builder /app/node_modules node_modules
# COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
# COPY --from=builder /app/tsconfig.base.json ./
# COPY --from=builder /app/packages/ packages/
# COPY --from=builder /app/apps/ apps/
# COPY --from=builder /app/drizzle/ drizzle/

# RUN chmod +x /app/apps/server/bin/loomail.mjs \
#     && ln -s /app/apps/server/bin/loomail.mjs /usr/local/bin/loomail

# COPY .env.example .env.example

# EXPOSE 3000

# # Hot reload: Node's built-in --watch with tsx as the TypeScript loader.
# # tsx watch uses its own file watcher; node --watch uses inotify on Linux.
# # On macOS Docker Desktop with grpcFUSE, inotify events from volume mounts
# # are not reliably delivered. Switch Docker Desktop to VirtioFS (Settings ->
# # General -> Virtual Machine Options -> VirtioFS) for reliable hot reload.
# # The server starts correctly either way; only reload-on-save is affected.
# #
# # Dashboard freshness: docker-compose.yml mounts ./apps over /app/apps, which
# # masks the dist built in this image with whatever apps/dashboard/dist on the
# # host happens to contain. Building the dashboard here, on every container
# # start, makes a stale dist impossible: the served assets always match the
# # mounted source. If the build fails the container exits instead of serving
# # old assets - a down container is loud, a stale one is silent.
# # Two build hygiene details:
# #   - rm -rf dist first: the image has no .git, so Tailwind's content scan
# #     does not apply .gitignore rules and would otherwise pick up class
# #     strings from the previous dist, bloating the CSS.
# #   - NODE_ENV=production for the build only: the compose environment sets
# #     NODE_ENV=development, which would make Vite bundle development React
# #     (roughly 1.7x the JS). The server itself still runs with
# #     NODE_ENV=development so the console login fallback keeps working.
# ENTRYPOINT ["sh", "-c", "rm -rf apps/dashboard/dist && NODE_ENV=production pnpm --filter @loomail/dashboard build && exec node --import /app/node_modules/tsx/dist/esm/index.mjs --watch apps/server/src/main.ts \"$@\"", "sh"]
# CMD ["--role=all"]

# Stage 3: Runner - production image, prod deps only.
FROM node:22-alpine AS runner

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

ENV NODE_ENV=production

ARG COMMIT_SHA=""
ARG BUILT_AT=""
ENV LOOMAIL_COMMIT_SHA=${COMMIT_SHA}
ENV LOOMAIL_BUILT_AT=${BUILT_AT}

COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=builder /app/tsconfig.base.json ./
COPY --from=builder /app/packages/ packages/
COPY --from=builder /app/apps/ apps/
COPY --from=builder /app/drizzle/package.json drizzle/
COPY --from=builder /app/drizzle/dist drizzle/dist
COPY --from=builder /app/drizzle/migrations drizzle/migrations

RUN pnpm install --frozen-lockfile --prod

RUN chmod +x /app/apps/server/bin/loomail.mjs \
    && ln -s /app/apps/server/bin/loomail.mjs /usr/local/bin/loomail

EXPOSE 3000

ENTRYPOINT ["node", "apps/server/dist/main.js"]
CMD ["--role=all"]