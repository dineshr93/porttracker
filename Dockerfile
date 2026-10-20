# Lightweight as possible: Alpine base, zero npm dependencies, so no
# install step — just copy the source and run.
FROM node:22-alpine

ENV NODE_ENV=production
ENV PORTTRACKERDIR=/data
WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY smoke.js ./
COPY public ./public

# /data is the default bind-mount point (CONTAINER_DATA in the Makefile);
# pre-create it so named-volume or plain-volume setups work out of the box.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

# Container's listening port (configurable at run time via PORT env var).
EXPOSE 3000

STOPSIGNAL SIGTERM

# Zero-dependency healthcheck via Node's built-in fetch.
HEALTHCHECK --start-period=5s --interval=30s --timeout=3s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
