FROM node:22-bookworm-slim
WORKDIR /app

# Claude Code's native installer ships a glibc-linked binary, hence
# bookworm-slim instead of alpine (musl) as the base here.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates bash \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/root/.local/bin:${PATH}"

COPY server.mjs providers.json ./
EXPOSE 3000
CMD ["node", "server.mjs"]
