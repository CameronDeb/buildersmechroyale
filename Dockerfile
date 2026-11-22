FROM oven/bun:1.4.4-slim
WORKDIR /bot
ENV MB_DUEL_BOOST=20
COPY package.json ./
COPY src ./src
ENTRYPOINT ["bun", "/bot/src/main.ts"]
