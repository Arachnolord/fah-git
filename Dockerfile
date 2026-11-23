# FAH-Git – schlanker Git-Server. Node ohne npm-Pakete + git.
# git-daemon bringt git-http-backend mit (bei Alpine nicht im Paket git).
FROM node:22-alpine
RUN apk add --no-cache git git-daemon rclone \
 && mkdir -p /daten && chown node:node /daten
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
ENV NODE_ENV=production PORT=3300 FAHGIT_DATEN=/daten HOME=/daten
USER node
EXPOSE 3300
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:3300/api/gesundheit >/dev/null || exit 1
CMD ["node", "src/server.js"]
