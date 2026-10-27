# Build: compile the TypeScript. The compiler stays in this stage. It runs
# on the machine building (its output is plain JavaScript, the same for any
# platform), so publishing for amd64 from Apple silicon doesn't run npm under
# emulation, where it breaks.
FROM --platform=$BUILDPLATFORM node:26-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

# Run: Node and the compiled action, nothing else.
FROM node:26-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec
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
