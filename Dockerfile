FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV DATABASE_PATH=/app/data/monitor.db
EXPOSE 3000
CMD ["node", "src/server.mjs"]
