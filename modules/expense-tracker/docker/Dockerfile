FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    qpdf \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json .
RUN npm install --production

# Bake the embedding model into the image for offline-safe, deterministic
# semantic memory at runtime. Non-fatal: runtime falls back to remote download
# (and then substring search) if this prefetch is skipped.
ENV TRANSFORMERS_CACHE=/app/.models
RUN node -e "import('@xenova/transformers').then(async ({pipeline,env})=>{env.cacheDir='/app/.models';await pipeline('feature-extraction','Xenova/all-MiniLM-L6-v2');console.log('embedding model cached');}).catch(e=>{console.warn('model prefetch skipped:',e.message);})" || true

COPY src/ ./src/

RUN mkdir -p /app/data /app/state

EXPOSE 8080

CMD ["node", "src/index.js"]
