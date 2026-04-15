# ---------- Stage 1: compile doomgeneric_server ----------
FROM debian:bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY doomgeneric/ doomgeneric/

WORKDIR /build/doomgeneric/doomgeneric
RUN make -f Makefile.server clean && make -f Makefile.server -j"$(nproc)"

# ---------- Stage 2: Node.js runtime ----------
FROM node:22-bookworm-slim

WORKDIR /app

# Install production dependencies first (layer cache).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Application code.
COPY index.js play.sh doom.sh setup-tls.sh ./

# Compiled Doom binary.
COPY --from=builder /build/doomgeneric/doomgeneric/doomgeneric_server \
     doomgeneric/doomgeneric/doomgeneric_server

# WAD file.
COPY doom1.wad doom1.wad

# Cert directory (may be mounted at runtime).
RUN mkdir -p certs

# Non-root user for security.
RUN chown -R node:node /app
USER node

# Internal ports (mapped via docker-compose or -p).
ENV PORT=8666
ENV TLS_PORT=8443
ENV ACCESS_TOKEN=slayer
EXPOSE 8666 8443

CMD ["node", "index.js"]
