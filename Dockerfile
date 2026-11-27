# FAH-Git – schlanker Git-Server. Node ohne npm-Pakete + git.
# git-daemon bringt git-http-backend mit (bei Alpine nicht im Paket git).
FROM node:22-alpine
RUN apk add --no-cache git git-daemon rclone \
 && mkdir -p /daten && chown node:node /daten
WORKDIR /app
# paket-manifest.txt + paket-signatur: das beim ZIP-Bau unterschriebene Release (1.15.0), fehlt beim Bau aus dem Repo.
COPY package.json paket-* ./
COPY src ./src
COPY public ./public
# Für den Fail-over (1.15.0): Der Haupt reicht seinen ganzen Programmstand als unterschriebenes Update-Paket weiter.
COPY manage.sh docker-compose.yml Dockerfile README.md ./
ENV NODE_ENV=production PORT=3300 FAHGIT_DATEN=/daten HOME=/daten
USER node
EXPOSE 3300
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:3300/api/gesundheit >/dev/null || exit 1
CMD ["node", "src/server.js"]
