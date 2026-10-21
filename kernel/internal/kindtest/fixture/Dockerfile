# The kind tests' fixture image (main.go). Standard library only.
FROM golang:1.27-alpine@sha256:f2c872bcee949b7be9c490efd02b48a8a2fbf947cdf533f1c58525ec9d8170fd AS build
WORKDIR /src
COPY main.go .
RUN go mod init fixture && CGO_ENABLED=0 go build -trimpath -o /fixture .

# Never root: steps run non-root with a read-only root filesystem (the
# kernel's pod hardening); /platform/output and /tmp are writable.
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /fixture /fixture
USER 65532
ENTRYPOINT ["/fixture"]
