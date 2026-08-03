# Lightweight as possible: Alpine base, zero npm dependencies, so no
# install step — just copy the source and run.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY public ./public

# Container's listening port (configurable at run time via PORT env var).
EXPOSE 3000

CMD ["node", "server.js"]
