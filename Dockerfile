# syntax=docker/dockerfile:1
ARG NODE_VERSION=26

FROM node:${NODE_VERSION}-slim AS build
RUN npm install -g pnpm@12.16.1
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# Every workspace package.json, so the install layer only changes when dependencies do.
COPY packages/core/package.json packages/core/
COPY packages/content-format/package.json packages/content-format/
COPY packages/theme-engine/package.json packages/theme-engine/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm deploy --filter @lithocms/server --prod /out

# TODO(phase-4): distroless base, uid 10001, read-only rootfs (see INSTALL_UPDATE.md).
FROM node:${NODE_VERSION}-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out .
# Mount the media volume here.
RUN mkdir -p /data/media && chown node:node /data/media
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/main.js"]
