FROM oven/bun:1.4.4-slim
WORKDIR /bot
ENV MB_PREF_LASER=18 MB_PREF_GUN=12
COPY package.json ./
COPY src ./src
ENTRYPOINT ["bun", "/bot/src/main.ts"]
