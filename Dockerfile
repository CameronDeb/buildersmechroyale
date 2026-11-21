FROM oven/bun:1.4.4-slim
WORKDIR /bot
COPY package.json ./
COPY src ./src
ENTRYPOINT ["bun", "/bot/src/main.ts"]
