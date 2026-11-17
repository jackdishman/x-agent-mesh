# syntax=docker/dockerfile:1
# node:24: node:sqlite (the default store) needs no flag.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# The SQLite file lives in /data (a mounted volume in production), writable by the node user.
RUN mkdir -p /data && chown -R node:node /data
# No USER line on purpose: a freshly mounted volume is owned by root, so the entrypoint starts as
# root only to chown /data, then drops to the non-root `node` user before exec'ing the CMD.
# (Started with `--user node`, it skips the chown and runs the CMD directly.)
EXPOSE 8787
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node","dist/index.js"]
