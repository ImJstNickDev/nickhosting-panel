# syntax=docker/dockerfile:1
FROM scratch AS ficsit-cli
ADD --checksum=sha256:2af0f8815af93b097c7a97968569575b21cf451b7c345fbb62fae29096ee4a31 https://github.com/satisfactorymodding/ficsit-cli/releases/download/v0.7.1/ficsit_linux_amd64 /ficsit_linux_amd64
ADD --checksum=sha256:a591eb87be517d9d03798184c210d7166141be19e37b9d4e5fe68c84f264c6bf https://github.com/satisfactorymodding/ficsit-cli/releases/download/v0.7.1/ficsit_linux_arm64 /ficsit_linux_arm64
FROM docker:29.6.2-cli@sha256:be132a9f282288de4afaf63379dff75711fda0147c6b72a9df44e51841402144 AS docker-cli
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS tooling
ARG TARGETARCH
COPY --from=ficsit-cli /ficsit_linux_${TARGETARCH} /usr/local/bin/ficsit
RUN chmod 755 /usr/local/bin/ficsit
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@10.33.0

FROM tooling AS dependencies
COPY . .
RUN pnpm install --frozen-lockfile

FROM dependencies AS development
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
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
COPY --from=tooling /usr/local/bin/ficsit /usr/local/bin/ficsit
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
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
