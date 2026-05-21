FROM oven/bun:1.3.2 AS builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY index.ts tsconfig.json ./
COPY src ./src

RUN bun build --compile --outfile /app/bash-command-mcp /app/index.ts

FROM oven/bun:1.3.2 AS runtime

WORKDIR /workspace
VOLUME ["/workspace"]

COPY --from=builder /app/bash-command-mcp /usr/local/bin/bash-command-mcp

EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/bash-command-mcp"]
