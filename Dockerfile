# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
COPY scripts/releaseDependencyPolicyCheck.mjs ./scripts/releaseDependencyPolicyCheck.mjs
RUN node scripts/releaseDependencyPolicyCheck.mjs --json \
  && npm ci

COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates docker.io git openssh-client \
  && mkdir -p /var/lib/siteflow/artifacts \
  && chown -R node:node /var/lib/siteflow \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY scripts/releaseDependencyPolicyCheck.mjs ./scripts/releaseDependencyPolicyCheck.mjs
RUN node scripts/releaseDependencyPolicyCheck.mjs --json \
  && npm ci --omit=dev --ignore-scripts \
  && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-cli ./dist-cli
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/dist-worker ./dist-worker
COPY --from=build /app/scripts/runCompiledScript.mjs ./scripts/runCompiledScript.mjs

USER node

EXPOSE 8787

CMD ["node", "dist-server/server/index.js"]
