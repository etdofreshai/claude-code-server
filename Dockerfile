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

# Copy the supervisor script (before USER switch so we can chmod)
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Create non-root user (claude can't use --dangerously-skip-permissions as root)
RUN useradd -m -s /bin/bash claude

# Create workspace directory
RUN mkdir -p /home/claude/workspace && chown claude:claude /home/claude/workspace

USER claude
WORKDIR /home/claude/workspace

# Environment variables (override at runtime)
ENV CLAUDE_CODE_ARGS="--permission-mode bypassPermissions"
ENV RESTART_DELAY="3"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
