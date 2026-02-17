FROM oven/bun:1.3.2

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY index.ts tsconfig.json ./

WORKDIR /workspace
VOLUME ["/workspace"]

CMD ["bun", "run", "/app/index.ts"]
