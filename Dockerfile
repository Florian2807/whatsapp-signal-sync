# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    CHROME_PATH=/usr/bin/chromium

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    chromium-sandbox \
    ca-certificates \
    ffmpeg \
    fonts-liberation \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

COPY public ./public
COPY src ./src

RUN mkdir -p /app/data /app/sessions \
 && chown -R node:node /app

EXPOSE 3000

USER node

ENTRYPOINT []
CMD ["node", "src/index.js"]
