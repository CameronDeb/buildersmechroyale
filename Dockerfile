FROM oven/bun:1.4.4-slim
WORKDIR /bot
ENV MB_PREF_LASER=30 MB_PREF_GUN=20
COPY package.json ./
COPY src ./src
ENTRYPOINT ["bun", "/bot/src/main.ts"]
