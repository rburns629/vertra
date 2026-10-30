#!/usr/bin/env python3
"""gcp/project's "check" action: whether it's ready on this install
(product.yaml's check). Changes nothing.

Run by the console with no inputs, as this product's identity. It asks
Google for a token as that identity (impersonating gcp-target when the
team's secret is mounted, as create does), then asks, with
testIamPermissions, whether it may create and delete projects under a
folder or organization it can see, and link them to a billing account it
can see. create's own parent and billingAccountId are per run, so it looks
for any: ready means there's at least one of each. Reports what's missing as
the roles to grant (the gcp team's README.md, Credentials).
"""

import json
import sys
from itertools import islice
from pathlib import Path
from typing import Any

import google.auth
import google.auth.credentials
import google.auth.exceptions
import google.auth.transport.requests
from google.api_core.exceptions import GoogleAPIError
from google.auth import impersonated_credentials
from google.cloud import resourcemanager_v3
from google.cloud.billing_v1 import CloudBillingClient

OUTPUT_PATH = Path("/platform/output/result.json")

# product.yaml's serviceAccount: the Kubernetes identity Workload Identity
# signs in as, named in what an admin must grant it.
SERVICE_ACCOUNT = "gcp-project"
TARGET_SERVICE_ACCOUNT_FILE = Path("/platform/secrets/gcp-target/service-account")
IMPERSONATION_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"]

# Cheap: at most this many folders, organizations and billing accounts asked about.
MAX_LOOKED_AT = 20
# What create and delete need where projects go, and the role that grants each.
PARENT_PERMISSIONS = {
    "resourcemanager.projects.get": "roles/browser",
    "resourcemanager.projects.create": "roles/resourcemanager.projectCreator",
    "resourcemanager.projects.delete": "roles/resourcemanager.projectDeleter",
}
BILLING_PERMISSION = "billing.resourceAssociations.create"  # roles/billing.user


def _write_result(result: dict[str, Any]) -> None:
    OUTPUT_PATH.write_text(json.dumps(result))


def _answer(ready: bool, principal: str, missing: list[str], detail: str) -> int:
    _write_result({
        "status": "succeeded",
        "outputs": {"ready": ready, "principal": principal, "missing": missing, "detail": detail},
    })
    return 0


def _failure(code: str, message: str, *, retryable: bool = False) -> int:
    _write_result(
        {"status": "failed", "error": {"code": code, "message": message, "retryable": retryable}}
    )
    return 1


def _sign_in() -> tuple[google.auth.credentials.Credentials, str]:
    """This product's credentials, refreshed (so they work), and who they are.
    Raises google.auth's DefaultCredentialsError or RefreshError when it can't."""
    target = TARGET_SERVICE_ACCOUNT_FILE.read_text().strip() if TARGET_SERVICE_ACCOUNT_FILE.exists() else ""
    source, _ = google.auth.default(scopes=IMPERSONATION_SCOPES)
    credentials = source
    if target:
        credentials = impersonated_credentials.Credentials(
            source_credentials=source, target_principal=target, target_scopes=IMPERSONATION_SCOPES
        )
    credentials.refresh(google.auth.transport.requests.Request())
    if target:
        return credentials, target
    # GKE's metadata server names the pool for a Kubernetes identity bound
    # directly (no Google service account): <project>.svc.id.goog.
    email = getattr(source, "service_account_email", "") or ""
    if email.endswith(".svc.id.goog"):
        return credentials, f"Kubernetes ServiceAccount {SERVICE_ACCOUNT}, by Workload Identity ({email})"
    if not email or email == "default":
        return credentials, f"Kubernetes ServiceAccount {SERVICE_ACCOUNT}, by Workload Identity"
    return credentials, email  # a Google service account bound to it


def _held(client: Any, resource: str, permissions: list[str]) -> set[str]:
    return set(client.test_iam_permissions(resource=resource, permissions=permissions).permissions)


def main() -> int:
    target = TARGET_SERVICE_ACCOUNT_FILE.read_text().strip() if TARGET_SERVICE_ACCOUNT_FILE.exists() else ""
    try:
        credentials, principal = _sign_in()
    except google.auth.exceptions.DefaultCredentialsError:
        return _answer(
            False, f"Kubernetes ServiceAccount {SERVICE_ACCOUNT}, with no Google identity",
            [f"GKE Workload Identity Federation for ServiceAccount {SERVICE_ACCOUNT} (the cluster's)"],
            "No Google credentials: this step isn't running with Workload Identity.",
        )
    except google.auth.exceptions.RefreshError as error:
        if target:
            return _answer(
                False, f"Kubernetes ServiceAccount {SERVICE_ACCOUNT}, impersonating {target}",
                [f"roles/iam.serviceAccountTokenCreator on {target}, for ServiceAccount {SERVICE_ACCOUNT}"],
                f"Couldn't impersonate gcp-target: {str(error)[:300]}",
            )
        return _answer(
            False, f"Kubernetes ServiceAccount {SERVICE_ACCOUNT}",
            [f"GKE Workload Identity Federation for ServiceAccount {SERVICE_ACCOUNT} (the cluster's)"],
            f"Couldn't get a Google token: {str(error)[:300]}",
        )
    except google.auth.exceptions.TransportError as error:
        return _failure("GCP_API_ERROR", f"couldn't reach Google to sign in: {error}", retryable=True)

    wanted = list(PARENT_PERMISSIONS)
    missing: list[str] = []
    try:
        folders = resourcemanager_v3.FoldersClient(credentials=credentials)
        organizations = resourcemanager_v3.OrganizationsClient(credentials=credentials)
        parents = [(folders, f.name) for f in islice(folders.search_folders(request={}), MAX_LOOKED_AT)]
        parents += [(organizations, o.name) for o in islice(organizations.search_organizations(request={}), MAX_LOOKED_AT)]
        # The parent it may do the most at: ready when that's everything.
        best: tuple[str, set[str]] | None = None
        for client, name in parents[:MAX_LOOKED_AT]:
            held = _held(client, name, wanted)
            if best is None or len(held) > len(best[1]):
                best = (name, held)
            if len(held) == len(wanted):
                break
        if best is None:
            roles = sorted(set(PARENT_PERMISSIONS.values()))
            missing.append(f"{', '.join(roles)} on the folder its projects go in")
        elif len(best[1]) < len(wanted):
            roles = sorted({PARENT_PERMISSIONS[p] for p in wanted if p not in best[1]})
            missing.append(f"{', '.join(roles)} on {best[0]}")

        billing = CloudBillingClient(credentials=credentials)
        accounts = [a.name for a in islice(billing.list_billing_accounts(request={}), MAX_LOOKED_AT)]
        if not any(BILLING_PERMISSION in _held(billing, a, [BILLING_PERMISSION]) for a in accounts):
            missing.append("roles/billing.user on the billing account it links")
    except GoogleAPIError as error:
        return _failure("GCP_API_ERROR", f"couldn't ask Google what it may do: {error}", retryable=True)

    if missing:
        return _answer(False, principal, missing, "It can sign in, but can't yet make projects here.")
    return _answer(True, principal, [], f"It may make and delete projects under {best[0]}, and link billing.")


if __name__ == "__main__":
    sys.exit(main())
