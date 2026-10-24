# syntax=docker/dockerfile:1

FROM node:24-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# pnpm version comes from "packageManager" in package.json.
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Full source with dev dependencies (tsx). Used by the worker and the
# one-shot migrate service.
FROM base AS tools
ENV NODE_ENV=production
# pg_dump for the worker's nightly backup (FIN-024): the same major version
# as the db service (Postgres 18; Alpine 3.23 or later). /backups is the
# backup volume's mount point, owned by the user the worker runs as.
RUN apk add --no-cache postgresql18-client \
    && mkdir -p /backups \
    && chown node:node /backups
COPY --from=deps /app/node_modules ./node_modules
COPY . .
USER node

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM base AS app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3000
CMD ["node", "server.js"]
