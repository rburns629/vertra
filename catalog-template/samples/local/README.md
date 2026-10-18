# local: one product, five languages

A sample team that runs anywhere, with no cloud and no secrets. Its products
are the same small product written five times, one per language: the
starters a new team copies for the languages it uses. As a whole team
(copied to `teams/local/`), its first publish proves an install end to end.

| Product | Language | What it does to `text` | How it runs |
|---|---|---|---|
| [`title-case`](products/title-case/) | Python | `hello world` → `Hello World` | `entrypoint.sh` runs `actions/transform.py` |
| [`reverse`](products/reverse/) | TypeScript | `hello world` → `dlrow olleh` (emoji stay whole) | compiled in a build stage; `entrypoint.sh` runs `actions/transform.js` with Node |
| [`slug`](products/slug/) | Go | `Hello, World!` → `hello-world` | a static binary on distroless, the entrypoint itself |
| [`upper-case`](products/upper-case/) | PowerShell | `hello world` → `HELLO WORLD` | `entrypoint.sh` runs `actions/transform.ps1` with `pwsh` |
| [`rot13`](products/rot13/) | Rust | `Hello` → `Uryyb` | a release binary on distroless, the entrypoint itself |

Every one has the action `transform`, the input `text` (up to 1,000
characters, since `result.json` is limited to 4 KB) and the outputs `text`
and `language`. They fail the same way too: `MISSING_INPUT` without text,
`TEXT_TOO_LONG` over the limit.

## Tests

Each product's tests are contract tests in `tests/transform/<case>/`: a
`request.json` input and the `expected.json` its `result.json` must contain.
They run against the built image the way the platform runs a step (the
request mounted at `/platform/input`, no network), so they test what
actually runs. Once copied into `teams/<team>/`, from the repository root:

```bash
./catalogctl check teams/<team>/products/slug     # validate, build, test, scan
```

## All five in one DAG

Each step takes the previous step's `text`. They need no secrets and no
ServiceAccount of their own, so this runs as soon as the team is published
(copy this folder to `teams/local/`, then `./catalogctl teams apply local`
and `./catalogctl publish teams/local/products/*`, or merge it for CI). `:latest` is
fine: the console pins each image to its digest when you submit. The
registry here is a local install's:

```yaml
name: five-languages
tasks:
  - id: python
    image: localhost:5001/local/title-case:latest
    action: transform
    team: local
    inputs:
      text: hello from five languages
  - id: typescript
    image: localhost:5001/local/reverse:latest
    action: transform
    team: local
    dependsOn: [python]
    inputs:
      text: {$fromTask: python, $output: text}
  - id: go
    image: localhost:5001/local/slug:latest
    action: transform
    team: local
    dependsOn: [typescript]
    inputs:
      text: {$fromTask: typescript, $output: text}
  - id: powershell
    image: localhost:5001/local/upper-case:latest
    action: transform
    team: local
    dependsOn: [go]
    inputs:
      text: {$fromTask: go, $output: text}
  - id: rust
    image: localhost:5001/local/rot13:latest
    action: transform
    team: local
    dependsOn: [powershell]
    inputs:
      text: {$fromTask: powershell, $output: text}
```

`hello from five languages` becomes `Hello From Five Languages`, then
`segaugnaL eviF morF olleH`, `segaugnal-evif-morf-olleh`,
`SEGAUGNAL-EVIF-MORF-OLLEH`, and finally `FRTNHTANY-RIVS-ZBES-BYYRU`.
