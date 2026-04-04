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

# Pre-accept the dangerous mode permission prompt
RUN mkdir -p /home/claude/.claude && \
    echo '{"skipDangerousModePermissionPrompt": true}' > /home/claude/.claude/settings.json && \
    chown -R claude:claude /home/claude/.claude

USER claude
WORKDIR /home/claude/workspace

# Environment variables (override at runtime)
ENV CLAUDE_CODE_ARGS="--dangerously-skip-permissions --remote-control"
ENV RESTART_DELAY="3"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
