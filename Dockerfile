# syntax=docker/dockerfile:1
# Mock Supplier API — zero-dependency Node.js app (no build step, no node_modules).

FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=4010 \
    PERSIST_DATA=1

WORKDIR /app

# Only the runtime files are needed. Paths are resolved relative to /app,
# so the server keeps finding ./server, ./dashboard and ./data.
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node dashboard ./dashboard
COPY --chown=node:node data ./data

# The mounted volume root may be owned by root, so only /app/data/store is
# prepared here (and re-created on demand by data-store.js).
RUN mkdir -p /app/data/store && chown -R node:node /app/data

# node:* images ship an unprivileged "node" user (uid 1000).
USER node

EXPOSE 4010

# Node >= 18 has a global fetch, so no curl/wget is required in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4010)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/server.js"]
