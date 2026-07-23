# Stage 1: Builder
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Copy package files first for better layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/adapters/package.json packages/adapters/
COPY packages/api/package.json packages/api/
COPY packages/worker/package.json packages/worker/
COPY packages/scheduler/package.json packages/scheduler/
COPY packages/brain-oss/package.json packages/brain-oss/
COPY apps/server/package.json apps/server/
COPY apps/dashboard/package.json apps/dashboard/

RUN pnpm install --frozen-lockfile

# Copy source
COPY tsconfig.base.json turbo.json ./
COPY packages/ packages/
COPY apps/ apps/

RUN pnpm build

# Stage 2: Runner
FROM node:20-alpine AS runner

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

ENV NODE_ENV=production

# Copy built output and production deps
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=builder /app/tsconfig.base.json ./
COPY --from=builder /app/packages/ packages/
COPY --from=builder /app/apps/ apps/

RUN pnpm install --frozen-lockfile --prod

COPY .env.example .env.example

EXPOSE 3000

# Default: run all roles. Override with --role=api|worker|scheduler
ENTRYPOINT ["node", "apps/server/dist/main.js"]
CMD ["--role=all"]
