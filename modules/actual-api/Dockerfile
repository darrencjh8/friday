FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 13 ships prebuilds in its tarball; no package has a real install
# script, and npm would otherwise run node-gyp (needs python/g++, absent here).
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && mkdir -p /tmp/actual-data
COPY *.js ./
EXPOSE 3000
CMD ["node", "server.js"]
