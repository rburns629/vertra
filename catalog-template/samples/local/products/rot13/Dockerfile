# Build: one release binary, from the locked dependency versions. The Rust
# toolchain stays in this stage.
FROM rust:1.98-slim-bookworm@sha256:ff521445a372125ed4f76e1453a1f8098f2d05332d1601d30db1c1f62757e730 AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src/ src/
RUN cargo build --release --locked

# Run: the binary alone, on a base with no shell or package manager (it
# links against glibc, hence distroless "cc"). It is the entrypoint itself
# and reads the action from its first argument, so there is no
# entrypoint.sh to run.
FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f
COPY --from=build /src/target/release/rot13 /app/rot13
# Never root (distroless's nonroot user). The platform's mounts work for any user.
USER 65532:65532
ENTRYPOINT ["/app/rot13"]
