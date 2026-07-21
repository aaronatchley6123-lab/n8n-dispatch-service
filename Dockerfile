FROM node:22-alpine
WORKDIR /app
COPY server.mjs providers.json ./
EXPOSE 3000
CMD ["node", "server.mjs"]
