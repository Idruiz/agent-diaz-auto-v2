FROM docker.io/cloudflare/sandbox:0.12.9 AS sandbox-runtime
FROM node:24-bookworm-slim

# The upstream image uses Ubuntu, whose Chromium package depends on snap.
# Keep the official sandbox server on Debian's native Chromium runtime.
COPY --from=sandbox-runtime /container-server /container-server
COPY --from=sandbox-runtime /usr/local/bin/bun /usr/local/bin/bun
COPY --from=sandbox-runtime /usr/local/bin/cloudflared /usr/local/bin/cloudflared

ENV DEBIAN_FRONTEND=noninteractive
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV NODE_PATH=/usr/local/lib/node_modules
ENV HOME=/home/sandbox
ENV SANDBOX_VERSION=0.12.9
ENV PYTHON_POOL_MIN_SIZE=0
ENV JAVASCRIPT_POOL_MIN_SIZE=0
ENV TYPESCRIPT_POOL_MIN_SIZE=0

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
    tar \
    git \
    curl \
    wget \
    ripgrep \
    jq \
    procps \
    sed \
    gawk \
    s3fs fuse3 squashfs-tools squashfuse fuse-overlayfs zip unzip file \
    && rm -rf /var/lib/apt/lists/*

RUN ln -sf /proc/mounts /etc/mtab \
    && sed -i 's/#user_allow_other/user_allow_other/' /etc/fuse.conf

RUN npm install -g --omit=dev \
    @playwright/mcp@0.0.80 \
    chrome-devtools-mcp@1.8.0 \
    puppeteer@25.10.0 \
    mcp-proxy@6.7.13

RUN mkdir -p /workspace \
    && useradd -m -s /bin/bash -d /home/sandbox sandbox \
    && chown sandbox:sandbox /workspace \
    && chmod 700 /root

EXPOSE 3000 8931 8932

USER sandbox
WORKDIR /workspace
ENTRYPOINT ["/container-server/sandbox"]
