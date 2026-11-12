# The team app. Runs with `rangoli app`; AWS settings come from the environment (deploy/aws/rangoli.yaml).
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages/engine/package.json packages/engine/
COPY packages/server/package.json packages/server/
COPY packages/editor/package.json packages/editor/
RUN npm ci
COPY packages packages
RUN npm run build

FROM node:22-bookworm-slim
# No Chromium here: this image holds database credentials, so rendering lives in Dockerfile.render.
# The RDS bundle lets the app verify the database's certificate.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL -o /etc/ssl/rds-global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production DB_SSL_CA=/etc/ssl/rds-global-bundle.pem HOST=0.0.0.0 PORT=4400
COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/
COPY packages/server/package.json packages/server/
COPY packages/editor/package.json packages/editor/
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/packages/engine/dist packages/engine/dist
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/editor/dist packages/editor/dist
USER node
EXPOSE 4400
CMD ["node", "packages/server/dist/cli.js", "app"]
