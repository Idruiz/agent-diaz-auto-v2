FROM node:22-bookworm-slim AS regression
ENV PUPPETEER_SKIP_DOWNLOAD=true
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends fontconfig fonts-dejavu-core fonts-liberation2 fonts-crosextra-carlito libreoffice-impress-nogui libreoffice-writer-nogui poppler-utils chromium \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .

FROM node:22-bookworm-slim AS build
ENV PUPPETEER_SKIP_DOWNLOAD=true
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    STORAGE_DIR=/app/storage
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends fontconfig fonts-dejavu-core fonts-liberation2 fonts-crosextra-carlito libreoffice-impress-nogui libreoffice-writer-nogui poppler-utils chromium \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*
RUN groupadd --system diaz && useradd --system --gid diaz --home-dir /app diaz
COPY --from=build --chown=diaz:diaz /app/package.json /app/package-lock.json ./
COPY --from=build --chown=diaz:diaz /app/node_modules ./node_modules
COPY --from=build --chown=diaz:diaz /app/dist ./dist
RUN mkdir -p storage/data storage/artifacts storage/uploads && chown -R diaz:diaz storage
USER diaz
EXPOSE 3000
VOLUME ["/app/storage"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node","dist/server/index.js"]
