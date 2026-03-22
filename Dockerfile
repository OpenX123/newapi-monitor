FROM node:18-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public/ ./public/

EXPOSE 3456

CMD ["node", "server.js"]
