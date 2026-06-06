# Multi-stage build for the Goldilocks backend.

FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && cp -R node_modules /tmp/prod_node_modules
RUN npm install
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# The official node image ships a `node` user (uid 1000) that the runtime
# drops to before CMD. Copies use --chown so the app dir is owned by node
# without a post-copy chown pass.
COPY --from=deps --chown=node:node /tmp/prod_node_modules ./node_modules
COPY --from=deps --chown=node:node /app/dist ./dist
COPY --from=deps --chown=node:node /app/migrations ./migrations
COPY --chown=node:node package.json ./

# Pre-create the volume mount points the backend + agent services write to,
# so node owns them when the named volumes are first attached. Docker only
# inherits this ownership for empty volumes — pre-existing volumes from
# earlier root-running deploys need a one-time `chown -R 1000:1000` on the
# host (see docs/production-setup.md).
RUN mkdir -p /var/lib/goldilocks-attachments /var/lib/goldilocks-agent \
    && chown -R node:node /var/lib/goldilocks-attachments /var/lib/goldilocks-agent

USER node

EXPOSE 4000
CMD ["node", "dist/server.js"]
