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
COPY .git/ .git/
COPY src/ src/
COPY public/ public/
RUN npm run build && \
    sed -i "s|__BUILD_DATETIME__|$(date -Iseconds)|g" dist/server.js && \
    sed -i "s|__BUILD_SHA__|$(git rev-parse HEAD 2>/dev/null || echo unknown)|g" dist/server.js && \
    rm -rf .git

# Set ownership and workspace
RUN mkdir -p /home/claude/workspace && chown claude:claude /home/claude/workspace
RUN chown -R claude:claude /app

USER claude
RUN git config --global user.name "ETdoFresh" && git config --global user.email "etdofresh@gmail.com"
WORKDIR /home/claude/workspace

# Environment variables
ENV PORT="3000"
ENV WORKSPACE_DIR="/home/claude/workspace"
ENV HUB_NAME="Hub"
ENV GH_TOKEN_ETDOFRESH=""
ENV GH_TOKEN_ETDOFRESHAI=""

EXPOSE 3000

COPY prompts/ /home/claude/workspace/prompts/

CMD ["node", "/app/dist/server.js"]
