# browser-bridge — Local Bridge node with a full browser stack.
#
# The agent interacts with Chrome/Playwright through bridge exec,
# the same way it runs shell commands on any bridge-connected machine.
#
# Build:  docker build -t tianshu82/browser-bridge .
# Run:    docker run -d --name browser-bridge \
#           -e TIANSHU_SERVER=https://your-tianshu:3456 \
#           -e TIANSHU_TOKEN=<pair-token> \
#           tianshu82/browser-bridge

FROM mcr.microsoft.com/playwright:v1.52.0-noble

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# System tools + compilers + language runtimes
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    curl wget jq git zip unzip \
    imagemagick ffmpeg \
    build-essential gcc g++ make cmake \
    golang-go \
    default-jdk \
    ruby \
    php-cli \
    && rm -rf /var/lib/apt/lists/*

# Rust (rustup, minimal profile)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"

# Deno
RUN curl -fsSL https://deno.land/install.sh | sh
ENV DENO_INSTALL="/root/.deno"
ENV PATH="${DENO_INSTALL}/bin:${PATH}"

# Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# pnpm
RUN npm i -g pnpm

# Python packages commonly needed by agents
RUN pip3 install --break-system-packages \
    requests beautifulsoup4 pandas \
    playwright

# Playwright browsers are already in the base image (Chromium, Firefox, WebKit).
# Install Playwright Python browsers binding.
RUN python3 -m playwright install-deps 2>/dev/null || true

# Playwright MCP server (for optional direct MCP usage)
RUN npm i -g @playwright/mcp@latest

# Tianshu Local Bridge (local build with --no-sandbox fix)
COPY tianshu-ai-local-bridge-*.tgz /tmp/
RUN npm i -g /tmp/tianshu-ai-local-bridge-*.tgz && rm /tmp/tianshu-ai-local-bridge-*.tgz

# Put Chromium where Playwright MCP expects the 'chrome' channel:
#   /opt/google/chrome/chrome  (standard Google Chrome install path)
# The base image may already have /opt/google/chrome/ as an empty dir.
RUN CHROME=$(find /ms-playwright/chromium-[0-9]*/chrome-linux -maxdepth 1 -name chrome -type f | head -1) && \
    echo "Resolved chrome binary: $CHROME" && \
    ln -sf "$CHROME" /usr/local/bin/chromium && \
    ln -sf "$CHROME" /usr/local/bin/chrome && \
    mkdir -p /opt/google/chrome && \
    ln -sf "$CHROME" /opt/google/chrome/chrome

# Working directory for agent tasks
WORKDIR /workspace

# Entrypoint: start local bridge.
# TIANSHU_SERVER and TIANSHU_TOKEN must be provided via env.
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
