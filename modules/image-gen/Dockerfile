FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json .
RUN npm install --production && npm install playwright
COPY server.js .
USER node
EXPOSE 8083
CMD ["node", "server.js"]
