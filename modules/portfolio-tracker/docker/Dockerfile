FROM node:22-slim

# Copy Java 21 JRE from Eclipse Temurin (Bookworm only ships OpenJDK 17)
COPY --from=eclipse-temurin:21-jre /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk
ENV PATH="${JAVA_HOME}/bin:${PATH}"

RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    poppler-utils \
    qpdf \
    python3 \
    make \
    gcc \
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
COPY pp-cli/target/pp-cli.jar /app/pp-cli.jar

RUN mkdir -p /app/data

EXPOSE 8081

CMD ["node", "src/index.js"]
