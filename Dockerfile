FROM node:22-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    jq \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code globally
RUN npm install -g @anthropic-ai/claude-code

# Create non-root user
RUN useradd -m -s /bin/bash claude

# Copy app source and build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src/ src/
ARG BUILD_SHA="unknown"
ARG BUILD_DATETIME="unknown"
ENV BUILD_SHA=${BUILD_SHA}
ENV BUILD_DATETIME=${BUILD_DATETIME}
RUN npm run build

# Set ownership and workspace
RUN mkdir -p /home/claude/workspace && chown claude:claude /home/claude/workspace
RUN chown -R claude:claude /app

USER claude
RUN git config --global user.name "ETdoFresh" && git config --global user.email "etdofresh@gmail.com"
WORKDIR /home/claude/workspace

# Environment variables
ENV PORT="3000"
ENV WORKSPACE_DIR="/home/claude/workspace"
ENV GH_TOKEN_ETDOFRESH=""
ENV GH_TOKEN_ETDOFRESHAI=""

EXPOSE 3000

CMD ["node", "/app/dist/server.js"]
