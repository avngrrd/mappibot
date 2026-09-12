FROM node:24-alpine
ENV NODE_ENV=production DATA_DIR=/app/data
WORKDIR /app
COPY --chown=node:node package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node src ./src
COPY --chown=node:node web ./web
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]
CMD ["node", "src/main.mjs"]
