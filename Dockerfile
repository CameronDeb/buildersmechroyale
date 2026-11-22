FROM oven/bun:1.4.4-slim
WORKDIR /bot
ENV MB_MODE=duel MB_PREF_LASER=50 MB_PREF_GUN=35
COPY package.json ./
COPY src ./src
ENTRYPOINT ["bun", "/bot/src/main.ts"]
