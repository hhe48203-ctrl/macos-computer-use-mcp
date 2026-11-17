# MCP server and JavaScript worker only. The Swift helper stays on the macOS
# host behind src/broker.mjs; this image holds no native code or host files.
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
USER node
ENTRYPOINT ["node", "src/server.mjs"]
