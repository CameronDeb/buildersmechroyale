FROM oven/bun:1.4.4-slim
WORKDIR /bot
ENV MB_W_NPC=-100 MB_W_CRATE=-100
COPY package.json ./
COPY src ./src
ENTRYPOINT ["bun", "/bot/src/main.ts"]
