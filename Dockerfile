FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit
COPY src ./src
RUN npm run build

FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY src/config ./src/config
COPY public ./public
EXPOSE 8080 40000-40200/udp
CMD ["node", "dist/http/server.js"]
