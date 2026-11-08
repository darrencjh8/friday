FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY server.mjs vercel.json ./
COPY api/_lib/pairing.ts ./api/_lib/pairing.ts
USER node
EXPOSE 8789
CMD ["node", "server.mjs"]
