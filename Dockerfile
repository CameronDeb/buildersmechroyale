FROM oven/bun:1.4.4-slim
WORKDIR /bot
ENV MB_JINK=0.4
COPY package.json ./
COPY src ./src
ENTRYPOINT ["bun", "/bot/src/main.ts"]
