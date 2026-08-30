FROM node:20-alpine
WORKDIR /app
COPY examples/mock-textbee-service.mjs ./server.mjs
EXPOSE 8090
CMD ["node", "server.mjs"]

