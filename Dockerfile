FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    git \
    openssh-client \
    python3 \
    sqlite3 \
    zsh \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && mkdir -p /app/logs /app/results /app/runtime-state /workspace/auto_archive_mk3 \
  && mkdir -p /home/deepsky \
  && chown -R node:node /app /workspace /home/deepsky
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY dist ./dist
COPY PROJECT.md README.md ./
USER node
CMD ["node", "dist/src/discord/discord-service-bootstrap.js"]
