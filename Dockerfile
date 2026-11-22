FROM oven/bun:1.4.4-slim
WORKDIR /bot
ENV MB_PRECHARGE=1
COPY package.json ./
COPY src ./src
ENTRYPOINT ["bun", "/bot/src/main.ts"]
