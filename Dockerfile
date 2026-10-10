# syntax=docker/dockerfile:1
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS tooling
WORKDIR /app
RUN npm install --global pnpm@10.33.0

FROM tooling AS dependencies
COPY . .
RUN pnpm install --frozen-lockfile

FROM dependencies AS development
RUN mkdir -p /app/mountdata && chown -R node:node /app
USER node
ENTRYPOINT ["node", "deploy/container-entry.mjs"]

FROM dependencies AS build
RUN pnpm build && pnpm build:runtime

FROM tooling AS production-dependencies
COPY --from=build /app/build/runtime/ ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=production-dependencies --chown=node:node /app/ ./
USER node
ENTRYPOINT ["node", "deploy/container-entry.mjs"]

FROM nginxinc/nginx-unprivileged:stable-alpine@sha256:15c994d10d6d78658721c3bcafff14cb281fba2a4bdf9d5ba92c416a472516e3 AS ingress
COPY deploy/nginx/start.sh /opt/nickhosting/start.sh
COPY deploy/nginx/proxy.conf /opt/nickhosting/proxy.conf
USER 101:101
ENTRYPOINT ["/bin/sh", "/opt/nickhosting/start.sh"]

FROM ingress AS dev-web
COPY deploy/nginx/dev.conf.template /opt/nickhosting/nginx.conf.template

FROM ingress AS prod-web
COPY deploy/nginx/prod.conf.template /opt/nickhosting/nginx.conf.template
COPY --from=build /app/apps/web/dist/ /usr/share/nginx/html/
