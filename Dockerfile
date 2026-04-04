FROM node:22-slim

# Install dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    jq \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code globally
RUN npm install -g @anthropic-ai/claude-code

# Create workspace directory
RUN mkdir -p /workspace

WORKDIR /workspace

# Copy the supervisor script
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Environment variables (override at runtime)
ENV CLAUDE_CODE_OAUTH_TOKEN=""
ENV CLAUDE_CODE_ARGS="--remote-control --dangerously-skip-permissions"
ENV RESTART_DELAY="3"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
