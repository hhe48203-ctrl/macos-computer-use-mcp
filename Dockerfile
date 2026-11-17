# MCP server and JavaScript worker only. The Swift helper stays on the macOS
# host behind src/broker.mjs; this image holds no native code or host files.
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
USER node
# The server may create its REPL Worker; neither the server nor that worker
# receives permission to spawn child processes. The worker also drops
# --allow-worker, so evaluated JS cannot create unrestricted worker threads.
# This is Node API defense-in-depth, NOT a security boundary for hostile JS.
ENTRYPOINT ["node", "--permission", "--allow-worker", "--allow-fs-read=/app", "src/server.mjs"]
