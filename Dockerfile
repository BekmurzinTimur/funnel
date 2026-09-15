# Single service, single port. The SQLite database lives on a volume mounted at /data —
# never mount the volume over /app, or the code is hidden and the container will not boot.

FROM node:22-bookworm-slim AS build
WORKDIR /app
# Toolchain only for the rare case better-sqlite3 has no prebuilt binary.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/funnel.db
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json tsconfig.json ./
COPY src ./src
COPY configs ./configs
EXPOSE 3000
# tsx runs the TypeScript server directly — there is no server build step.
CMD ["node_modules/.bin/tsx", "src/server/index.ts"]
