# Architecture diagrams

[`acyclix.drawio`](acyclix.drawio) opens in draw.io (desktop, diagrams.net, or the VS Code extension). It has five pages, each also exported as an SVG here:

| Page | What it shows |
| --- | --- |
| [1 · System](1-system.svg) | What runs where on GKE and in the GCP project around it, the catalog's GitHub workflows, and how one execution flows through them (① to ⑤). |
| [2 · Kernel classes](2-kernel-classes.svg) | UML of `kernel/app`: every module, class (pydantic, table, enum, dataclass, error) and function, grouped by layer, with the imports between layers. |
| [3 · Console classes](3-console-classes.svg) | The same for `console/src` and `console/frontend/src`, including every HTTP route each module registers and the Drizzle tables. |
| [4 · Submit to finished](4-submit-to-finished.svg) | A UML sequence diagram of one execution, call by call, from `POST /api/executions` through claiming, dispatch, polling and finalizing. |
| [5 · States](5-states.svg) | The task and execution state machines, with the function that makes each transition. |

The database tables are drawn in the console's guide, [`console/docs/06-database-schemas.md`](../../console/docs/06-database-schemas.md) (Docs → *Where Acyclix keeps its data*).

## Keeping them current

All five pages are written by [`generate.py`](generate.py). Pages 2 and 3 are read from the source code, so they're only right if someone reruns the script after the code changes:

```console
$ python3 docs/architecture/generate.py
```

It rewrites `acyclix.drawio` and, when draw.io's desktop app is installed, the SVGs. A rerun overwrites the file, so change a layout in `generate.py` rather than by dragging boxes in draw.io. Pages 1, 4 and 5 are laid out by hand in the script: update them when the deployment, the call path or the state rules change.
