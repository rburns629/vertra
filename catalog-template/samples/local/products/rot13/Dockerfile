# Build: one release binary, from the locked dependency versions. The Rust
# toolchain stays in this stage.
FROM rust:1.98-slim-bookworm@sha256:ff521445a372125ed4f76e1453a1f8098f2d05332d1601d30db1c1f62757e730 AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src/ src/
# Linked statically (it needs nothing from glibc it can't carry), so it runs
# on distroless "static": no libc or OpenSSL in the image to need patching.
RUN target="$(rustc -vV | sed -n 's/^host: //p')" \
 && RUSTFLAGS="-C target-feature=+crt-static" cargo build --release --locked --target "$target" \
 && cp "target/$target/release/rot13" /src/rot13

# Run: the binary alone, on a base with no shell or package manager. It is
# the entrypoint itself and reads the action from its first argument, so
# there is no entrypoint.sh to run.
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /src/rot13 /app/rot13
# Never root (distroless's nonroot user). The platform's mounts work for any user.
USER 65532:65532
ENTRYPOINT ["/app/rot13"]
