# gcp: real Google Cloud calls

Example products that call real Google Cloud APIs, to copy from when your
product has to. Running them costs money.

| Product | What `create` does |
|---|---|
| [`project`](products/project/) | Finds a project by id, or creates it (linking billing) |
| [`build-image`](products/build-image/) | Builds an image with Cloud Build from a source archive in GCS (with a Dockerfile at its root), unless that image already exists |
| [`app-hosting`](products/app-hosting/) | Deploys an image to Cloud Run, or returns the existing service's URL; optionally connects a Cloud SQL instance |
| [`cloud-sql`](products/cloud-sql/) | Finds a Cloud SQL instance by name, or creates it (several minutes; set `timeoutSeconds` to 900 or more, and delete it after) |

Every action looks before it creates, so a retried step is harmless.
[dags/gcp-hello-world-dag.yaml](dags/gcp-hello-world-dag.yaml) chains the
first three.

## Credentials

No keys: the actions use Application Default Credentials, which GKE
Workload Identity supplies from the step's Kubernetes ServiceAccount. These
examples don't declare one yet, so they run as the namespace's `default`.
For real use, give each product its own: `serviceAccount: <name>` in its
`product.yaml` (the console creates it in the `gcp` namespace, and the
cluster lets only that product's image run as it), bound to a Google service
account granted only what that product does (for `project`'s lookup,
`roles/browser`). Don't bind `default`: every unregistered image runs as it.

Optionally, the actions impersonate a second service account, using their
own identity only to mint its tokens: register a team secret `gcp-target`
whose key `service-account` is that account's email, and list it in each
action that should act as it:

```yaml
    secretRefs:
      - name: gcp-target
        keys: [service-account]
```

It's mounted at `/platform/secrets/gcp-target/service-account` for those
steps only, so each team (and each product) chooses its own. The first
account needs `roles/iam.serviceAccountTokenCreator` on the second. Leave it
out when the bound identity already is the one to act as: impersonating
yourself fails, after a minute's timeout, as `PERMISSION_DENIED`.
