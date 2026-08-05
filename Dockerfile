FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates poppler-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node public ./public
COPY --chown=node:node server.js ./server.js

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4173 \
    APP_VERSION=1.1.0

USER node
EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4173/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
