FROM node:18-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public/ ./public/

EXPOSE 3456

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3456)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

# 用 node 直接作为 PID 1 会收不到默认的信号转发，这里显式让 tini 之外的场景也能收到 SIGTERM
STOPSIGNAL SIGTERM

CMD ["node", "server.js"]
