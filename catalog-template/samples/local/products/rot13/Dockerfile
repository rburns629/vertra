# Build: one release binary, from the locked dependency versions. The Rust
# toolchain stays in this stage.
FROM rust:1.90-slim-bookworm@sha256:64232e656c058f4468e8d024e990acff04f0fd5a5c0a88a574dc37773d7325c9 AS build
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
