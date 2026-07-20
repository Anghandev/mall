FROM node:24.14.0-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY platform-v2/package.json platform-v2/package.json
COPY platform-v2/admin/package.json platform-v2/admin/package.json
COPY mall-v2/package.json mall-v2/package.json
COPY merchant-v2/package.json merchant-v2/package.json
COPY packages/core-artifacts/package.json packages/core-artifacts/package.json
RUN pnpm install --prod --frozen-lockfile

COPY scripts/node scripts/node
COPY platform-v2/server platform-v2/server
COPY platform-v2/scripts platform-v2/scripts
COPY packages/core-artifacts packages/core-artifacts

RUN mkdir -p /var/lib/abu24k /var/lib/abu24k-media \
    && chown -R node:node /var/lib/abu24k /var/lib/abu24k-media

USER node
CMD ["pnpm", "--filter", "@abu24k/core", "start"]
