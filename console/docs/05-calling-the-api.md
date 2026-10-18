# Calling the API from a pipeline

Everything the console does, a pipeline can do over HTTP: submit a DAG, wait for it, read its outputs and logs. A team's bot signs in with an API token; every endpoint is listed in the [API reference](api-reference.md).

In the examples, the console is `https://acyclix.example.com` and the team is `team-a`. Lines starting with `$` are what you type; the lines under them are what you get back.

## 1. Get a token

In the console, open your team → **Automation → Add a bot**, say what will use it, and copy the token: it's shown only once. The bot acts as a member of your team, and of nothing else. Store the token as a secret in your pipeline, for example:

```console
$ gh secret set ACYCLIX_TOKEN --repo <your-org>/<your-repo>
```

Every request sends it as a bearer token:

```console
$ export ACYCLIX=https://acyclix.example.com
$ curl -s $ACYCLIX/api/me -H "Authorization: Bearer $ACYCLIX_TOKEN"
{"id":"3f0c…","email":"team-a-release-pipeline@bots.acyclix.local","teamNames":["team-a"],"isAdmin":false}
```

## 2. Submit a DAG

Send the DAG as JSON. A pipeline that might retry after a timeout should set a `requestId` it can repeat, for example its run id: the same `requestId` returns the run already started instead of starting a second one.

```console
$ cat dag.json
{
  "name": "nightly-check",
  "requestId": "nightly-check-run-4812",
  "tasks": [
    {
      "id": "say-hello",
      "image": "us-central1-docker.pkg.dev/my-gcp-project/catalog-products/team-a-hello-product:latest",
      "action": "greet",
      "team": "team-a",
      "serviceAccount": "default",
      "inputs": { "name": "Anna" }
    }
  ]
}
$ curl -s -X POST $ACYCLIX/api/executions \
    -H "Authorization: Bearer $ACYCLIX_TOKEN" \
    -H "Content-Type: application/json" \
    -d @dag.json
{"executionId":"6b7a4378-6939-4270-8f96-c288e78571a6","state":"PENDING"}
```

## 3. Wait for it to finish

Ask for the execution until its `state` is `SUCCEEDED`, `FAILED` or `CANCELLED`:

```console
$ ID=6b7a4378-6939-4270-8f96-c288e78571a6
$ curl -s $ACYCLIX/api/executions/$ID -H "Authorization: Bearer $ACYCLIX_TOKEN" | jq '{state, tasks: [.tasks[] | {taskId, state, outputs, failure}]}'
{
  "state": "SUCCEEDED",
  "tasks": [
    { "taskId": "say-hello", "state": "SUCCEEDED", "outputs": { "message": "Hello, Anna!", "secretFound": false }, "failure": null }
  ]
}
```

A small loop, for a pipeline step:

```bash
while :; do
  state=$(curl -s "$ACYCLIX/api/executions/$ID" -H "Authorization: Bearer $ACYCLIX_TOKEN" | jq -r .state)
  case "$state" in
    SUCCEEDED) break ;;
    FAILED|CANCELLED) echo "Execution $ID ended $state"; exit 1 ;;
  esac
  sleep 10
done
```

## 4. Read the logs

```console
$ curl -s $ACYCLIX/api/executions/$ID/logs -H "Authorization: Bearer $ACYCLIX_TOKEN"
{"tasks":[{"taskId":"say-hello","lines":["greeting Anna"]}]}
```

To list executions, newest first, a page at a time (pass `nextCursor` back as `cursor` for the next page; `team`, `search` and `since` narrow it):

```console
$ curl -s "$ACYCLIX/api/executions?limit=20&team=$TEAM" -H "Authorization: Bearer $ACYCLIX_TOKEN" | jq '{nextCursor, executions: [.executions[] | {name, state}]}'
```

## Errors

Every error has the same shape, with a code a pipeline can branch on:

```json
{"error": "FORBIDDEN", "message": "Secret \"hello-secret\" is not registered for team \"team-a\". Add it on the team's Secrets tab."}
```

| Status | Means |
| --- | --- |
| 400 | The request is malformed |
| 401 | The token is missing, wrong or revoked |
| 403 | The bot isn't allowed this, e.g. a task for another team or a secret it wasn't given |
| 404 | No such execution, or not one your team can see |
| 409 | Not possible right now, e.g. the team is retired |
| 422 | The DAG itself is invalid; `message` says where |
| 429 | Too many attempts; wait the number of seconds in `Retry-After` |

Revoking the bot's token (Team page → **Automation**) stops it working immediately.
