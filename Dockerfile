# ── Stage 1: Build ─────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ── Stage 2: Run ──────────────────────────────────────────────────
FROM node:20-slim

# Install Python (required by some yt-dlp features) and curl
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      python3 \
      curl \
      ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Download yt-dlp binary directly
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
    -o /usr/local/bin/yt-dlp && \
    chmod +x /usr/local/bin/yt-dlp

WORKDIR /app

# Copy node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy app source
COPY . .

# Pre-create the bin directory and symlink yt-dlp so the app finds it
RUN mkdir -p bin && ln -s /usr/local/bin/yt-dlp bin/yt-dlp

# Create tmp directory for downloads
RUN mkdir -p tmp

# Expose port (Render sets PORT env var automatically)
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://localhost:${PORT:-3000}/ || exit 1

CMD ["node", "server.js"]
