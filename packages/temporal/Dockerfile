# Temporal worker — portable Dockerfile
# Works on: Railway, Fly.io, GCP Cloud Run, AWS ECS, Oracle Cloud, any Docker host
#
# Build:  docker build -t guardian-worker .
# Run:    docker run --env-file .env guardian-worker

FROM node:22-slim AS base
RUN corepack enable pnpm

WORKDIR /app

# Copy workspace root files needed for pnpm install
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./

# Copy only the packages the worker needs
COPY packages/temporal/package.json packages/temporal/
COPY packages/orchestrations/package.json packages/orchestrations/

# Install dependencies (production only)
RUN pnpm install --frozen-lockfile --filter @guardian/temporal --filter @guardian/orchestrations

# Copy source code
COPY packages/temporal/ packages/temporal/
COPY packages/orchestrations/ packages/orchestrations/

WORKDIR /app/packages/temporal

# No HTTP port — this is a worker process
CMD ["pnpm", "exec", "tsx", "src/worker.ts"]
