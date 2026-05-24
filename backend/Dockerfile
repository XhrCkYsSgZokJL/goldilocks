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
COPY --from=deps /tmp/prod_node_modules ./node_modules
COPY --from=deps /app/dist ./dist
COPY --from=deps /app/migrations ./migrations
COPY package.json ./
EXPOSE 4000
CMD ["node", "dist/server.js"]
