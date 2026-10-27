# Teams

One folder per team: `teams/<team>/` with its `team.yaml`, its
`products/`, and optionally its `secret-stores/`, `dags/`, `apis/` and
`types.yaml` (the wiring types it defines: the catalog's `README.md`, Type
outputs too). Start one from
`templates/team/team.yaml` and `templates/hello`, or copy a starter product
in your language from `samples/local/products/` (Python, TypeScript, Go,
PowerShell, Rust), changing its `team:` to your team's name. The catalog's
`README.md` has the steps.
