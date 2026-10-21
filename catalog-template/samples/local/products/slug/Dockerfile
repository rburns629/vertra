# Build: one static binary. The Go toolchain stays in this stage.
FROM golang:1.27-bookworm@sha256:972b4110ba0f47539a975c31e52c64765e1ff19f2d74469ae4a595c6676e80a5 AS build
WORKDIR /src
COPY go.mod ./
COPY main.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/slug .

# Run: the binary alone, on a base with no shell or package manager. It is
# the entrypoint itself and reads the action from its first argument, so
# there is no entrypoint.sh to run.
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /out/slug /app/slug
# Never root (distroless's nonroot user). The platform's mounts work for any user.
USER 65532:65532
ENTRYPOINT ["/app/slug"]
