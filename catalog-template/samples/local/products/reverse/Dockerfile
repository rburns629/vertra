# Build: compile the TypeScript. The compiler stays in this stage.
FROM node:24-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

# Run: Node and the compiled action, nothing else.
FROM node:24-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
# Security fixes released since the base image was published: CI's scan
# fails on a high or critical vulnerability that has a fix.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*
# The action runs on node alone. npm and corepack ship in the base image and
# carry their own dependencies (and vulnerabilities); nothing here uses them.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

WORKDIR /app
COPY entrypoint.sh /app/entrypoint.sh
COPY --from=build /src/dist/transform.js /app/actions/transform.js
RUN chmod +x /app/entrypoint.sh /app/actions/*

# Never root. The platform's mounts work for any user.
ENV HOME=/tmp
USER 65532:65532

ENTRYPOINT ["/app/entrypoint.sh"]
