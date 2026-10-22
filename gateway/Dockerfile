# The gateway: one static binary. On the builder's own platform,
# cross-compiling for the target: no emulation.
FROM --platform=$BUILDPLATFORM golang:1.27-alpine@sha256:f2c872bcee949b7be9c490efd02b48a8a2fbf947cdf533f1c58525ec9d8170fd AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/gateway ./cmd/gateway

# No shell, no package manager: CA certificates, /tmp and the binary.
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /out/gateway /usr/local/bin/gateway
USER 65532
EXPOSE 8080 8081 9090
ENTRYPOINT ["/usr/local/bin/gateway"]
