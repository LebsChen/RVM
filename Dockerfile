# RVM (Remote Virtual Machines) Dockerfile
# Based on Debian Bookworm with Node 20 LTS & Desktop/VNC runtime tools

FROM node:20-bookworm-slim

# Install system dependencies for RVM capabilities (git, VNC, ffmpeg, browser)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    wget \
    procps \
    net-tools \
    ca-certificates \
    xvfb \
    x11vnc \
    openbox \
    ffmpeg \
    chromium \
    python3 \
    make \
    g++ \
    unzip \
    tar \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package definitions and install dependencies
COPY rvm/package*.json ./
RUN npm ci || npm install --production

# Copy application source code
COPY rvm/ ./

# Set default container environment variables
ENV PORT=9876 \
    TOKEN=devin-rvm-secret-token \
    ROOT=/workspace \
    VNC_PASSWORD=devin \
    BIND=0.0.0.0 \
    DISPLAY=:99 \
    AUTO_INSTALL=git,novnc,ffmpeg

# Setup workspace and data directories
RUN mkdir -p /workspace /root/.rvm

# Expose RVM REST API/WebSocket port (9876) and VNC port (5900)
EXPOSE 9876 5900

# Docker Healthcheck
HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:${PORT:-9876}/api/health || exit 1

# Start RVM agent with Xvfb display server support
CMD ["sh", "-c", "if command -v Xvfb >/dev/null 2>&1; then Xvfb :99 -screen 0 1280x1024x24 >/dev/null 2>&1 & fi && node agent/agent.js"]
