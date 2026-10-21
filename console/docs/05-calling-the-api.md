# Calling the API from a pipeline

Everything the console does, a pipeline can do over HTTP: submit a DAG, wait for it, read its outputs and logs. A team's bot signs in with an API token; every method is listed in the [API reference](api-reference.md).

Each method is one URL, `POST /api/vertra.console.v1.<Service>/<Method>`, taking a JSON body and returning JSON: the Connect protocol, which is plain HTTP, so `curl` and `jq` are all you need. The same methods can be called over gRPC, or with a typed client generated from the protos in the platform's repository (`proto/vertra/console/v1`).

In the examples, the console is `https://vertra.example.com` and the team is `team-a`. Lines starting with `$` are what you type; the lines under them are what you get back.

## 1. Get a token

In the console, open your team → **Automation → Add a bot**, say what will use it, and copy the token: it's shown only once. The bot acts as a member of your team, and of nothing else. Store the token as a secret in your pipeline, for example:

```console
$ gh secret set VERTRA_TOKEN --repo <your-org>/<your-repo>
```

Every call sends it as a bearer token. A small helper keeps the examples short:

```console
$ export VERTRA=https://vertra.example.com
$ call() { curl -s -X POST "$VERTRA/api/vertra.console.v1.$1" -H "Authorization: Bearer $VERTRA_TOKEN" -H "Content-Type: application/json" -d "${2:-{\}}"; }
$ call AuthService/GetMe
{"userId":"3f0c…","email":"team-a-release-pipeline@bots.vertra.local","teamNames":["team-a"],"isAdmin":false}
```

## 2. Submit a DAG

Send the DAG as `dag`. A pipeline that might retry after a timeout should set a `requestId` it can repeat, for example its run id: the same `requestId` returns the run already started instead of starting a second one.

```console
$ cat dag.json
{
  "name": "nightly-check",
  "requestId": "nightly-check-run-4812",
  "tasks": [
    {
      "id": "say-hello",
      "image": "us-central1-docker.pkg.dev/my-gcp-project/catalog-products/team-a/hello:latest",
      "action": "greet",
      "team": "team-a",
      "inputs": { "name": "Anna" }
    }
  ]
}
$ call ExecutionService/SubmitExecution "$(jq -c '{dag: .}' dag.json)"
{"executionId":"6b7a4378-6939-4270-8f96-c288e78571a6","state":"EXECUTION_STATE_PENDING"}
```

### Or run a template

A team's template runs with its parameters only: its steps, images,
identities and secrets are the team's, whatever you're allowed to submit.
List what's shared with you, then run one:

```console
$ call TemplateService/ListTemplates | jq -r '.runnables[] | "\(.team)/\(.name)"'
local/shout-backwards
$ call TemplateService/RunTemplate '{"team":"local","name":"shout-backwards","parameters":{"text":"hello"}}'
{"executionId":"0c1f…","state":"EXECUTION_STATE_PENDING"}
```

Parameters that don't fit the template's schema are refused before
anything runs. A template shared with specific teams runs on behalf of one
of yours (`onBehalfOf`). `TemplateService/RunAction` runs one shared action
the same way, its inputs as the parameters.

## 3. Wait for it to finish

Ask for the execution until its `state` is `EXECUTION_STATE_SUCCEEDED`, `_FAILED` or `_CANCELLED`:

```console
$ ID=6b7a4378-6939-4270-8f96-c288e78571a6
$ call ExecutionService/GetExecution "{\"executionId\":\"$ID\"}" | jq '.execution | {state, tasks: [.tasks[] | {taskId, state, outputs, failure}]}'
{
  "state": "EXECUTION_STATE_SUCCEEDED",
  "tasks": [
    { "taskId": "say-hello", "state": "TASK_STATE_SUCCEEDED", "outputs": { "message": "Hello, Anna!", "secretFound": false }, "failure": null }
  ]
}
```

A small loop, for a pipeline step:

```bash
while :; do
  state=$(call ExecutionService/GetExecution "{\"executionId\":\"$ID\"}" | jq -r .execution.state)
  case "$state" in
    EXECUTION_STATE_SUCCEEDED) break ;;
    EXECUTION_STATE_FAILED|EXECUTION_STATE_CANCELLED) echo "Execution $ID ended $state"; exit 1 ;;
  esac
  sleep 10
done
```

A client generated from the protos can call `ExecutionService/WatchExecution` instead, which streams the execution each time it changes until it finishes.

## 4. Read the logs

```console
$ call ExecutionService/GetExecutionLogs "{\"executionId\":\"$ID\"}"
{"tasks":[{"taskId":"say-hello","lines":["greeting Anna"]}]}
```

To list executions, newest first, a page at a time (pass `nextCursor` back as `page.cursor` for the next page; it's empty on the last; `team`, `search` and `since` narrow it):

```console
$ call ExecutionService/ListExecutions '{"page":{"limit":20},"team":"team-a"}' | jq '{nextCursor, executions: [.executions[] | {name, state}]}'
```

## Errors

Every error has the same shape: a code from a short, fixed list, a message for a person, and a `Failure` detail with a stable code a pipeline can branch on (in `debug`, readable with `jq`):

```console
$ call ExecutionService/SubmitExecution "$(jq -c '{dag: .}' dag.json)" | jq '{code, message, failure: .details[0].debug.code}'
{
  "code": "permission_denied",
  "message": "Secret \"hello-secret\" is not registered for team \"team-a\". Add it on the team's Secrets tab.",
  "failure": "FORBIDDEN"
}
```

| Code (HTTP status) | Means |
| --- | --- |
| `invalid_argument` (400) | The request or the DAG is invalid; `message` says where, and a `Problem` detail names each field |
| `unauthenticated` (401) | The token is missing, wrong or revoked |
| `permission_denied` (403) | The bot isn't allowed this, e.g. a task for another team or a secret it wasn't given |
| `not_found` (404) | No such execution, or not one your team can see |
| `already_exists` (409) | It exists already, e.g. a team of that name |
| `failed_precondition` (400) | Not possible right now, e.g. the team is retired (`TEAM_RETIRED`) |
| `resource_exhausted` (429) | Too many attempts; wait the number of seconds in `Retry-After` |
| `unavailable` (503) | The console can't reach something it needs; try again |

Revoking the bot's token (Team page → **Automation**) stops it working immediately.
