#!/usr/bin/env python3
"""aws/app-runner's "create" action: deploys a container image as an App
Runner service, or returns the existing service's URL if one of that name
exists. Never builds an image: `image` is an ECR (or ECR Public) reference.

The service is reachable only through a VPC interface endpoint unless
`public` is true. Waits for a new service to be running, so later steps can
use its URL. Credentials as in the aws team's README.md: boto3's default
chain (EKS Pod Identity or IRSA), optionally assuming AWS_TARGET_ROLE_ARN.
"""

import json
import os
import sys
import time
from pathlib import Path
from typing import Any

import boto3
from botocore.exceptions import BotoCoreError, ClientError, NoCredentialsError

INPUT_PATH = Path("/platform/input/request.json")
OUTPUT_PATH = Path("/platform/output/result.json")

TARGET_ROLE_ENV_VAR = "AWS_TARGET_ROLE_ARN"
RETRYABLE_CODES = {
    "Throttling", "ThrottlingException", "RequestLimitExceeded", "TooManyRequestsException",
    "ServiceUnavailable", "InternalError", "InternalFailure", "InternalServiceErrorException",
}
# How long a new service may take to start before the step gives up (the
# step's timeoutSeconds must be longer).
START_TIMEOUT_SECONDS = 900
POLL_SECONDS = 10


def _write_result(result: dict[str, Any]) -> None:
    OUTPUT_PATH.write_text(json.dumps(result))


def _failure(code: str, message: str, *, retryable: bool = False) -> int:
    _write_result(
        {"status": "failed", "error": {"code": code, "message": message, "retryable": retryable}}
    )
    return 1


def _aws_failure(error: Exception) -> int:
    if isinstance(error, NoCredentialsError):
        return _failure("AWS_NO_CREDENTIALS", "No AWS credentials: is the step's ServiceAccount bound to an IAM role?")
    if isinstance(error, ClientError):
        details = error.response.get("Error", {})
        status = error.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0)
        code = details.get("Code", "Unknown")
        retryable = code in RETRYABLE_CODES or status >= 500
        return _failure("AWS_API_ERROR", f"{code}: {details.get('Message', '')}", retryable=retryable)
    return _failure("AWS_API_ERROR", str(error), retryable=True)


def _session(region: str) -> boto3.session.Session:
    session = boto3.session.Session(region_name=region)
    target = os.environ.get(TARGET_ROLE_ENV_VAR)
    if not target:
        return session
    credentials = session.client("sts").assume_role(
        RoleArn=target, RoleSessionName="acyclix-step"
    )["Credentials"]
    return boto3.session.Session(
        aws_access_key_id=credentials["AccessKeyId"],
        aws_secret_access_key=credentials["SecretAccessKey"],
        aws_session_token=credentials["SessionToken"],
        region_name=region,
    )


def _find_service(apprunner: Any, name: str) -> dict[str, Any] | None:
    token = None
    while True:
        page = apprunner.list_services(**({"NextToken": token} if token else {}))
        for summary in page.get("ServiceSummaryList", []):
            if summary.get("ServiceName") == name and summary.get("Status") != "DELETED":
                return summary
        token = page.get("NextToken")
        if not token:
            return None


def _outputs(service: dict[str, Any]) -> dict[str, Any]:
    return {"serviceUrl": f"https://{service['ServiceUrl']}", "serviceArn": service["ServiceArn"]}


def main() -> int:
    inputs = json.loads(INPUT_PATH.read_text()).get("inputs", {})
    name, image, region = inputs.get("serviceName"), inputs.get("image"), inputs.get("region")
    if not name or not image or not region:
        return _failure("MISSING_INPUT", "inputs.serviceName, inputs.image and inputs.region are required")
    environment = inputs.get("environment") or {}
    if not all(isinstance(v, str) for v in environment.values()):
        return _failure("INVALID_INPUT", "inputs.environment values must be strings")

    try:
        apprunner = _session(region).client("apprunner")
        existing = _find_service(apprunner, name)
        if existing:
            print(f"service '{name}' already exists ({existing.get('Status')}), leaving it as it is")
            _write_result({"status": "succeeded", "outputs": _outputs(existing)})
            return 0

        repository: dict[str, Any] = {
            "ImageIdentifier": image,
            "ImageRepositoryType": "ECR_PUBLIC" if image.startswith("public.ecr.aws/") else "ECR",
            "ImageConfiguration": {
                "Port": str(inputs.get("port", 8080)),
                "RuntimeEnvironmentVariables": environment,
            },
        }
        source: dict[str, Any] = {"ImageRepository": repository, "AutoDeploymentsEnabled": False}
        if inputs.get("accessRoleArn"):  # pulling from a private ECR repository
            source["AuthenticationConfiguration"] = {"AccessRoleArn": inputs["accessRoleArn"]}
        service = apprunner.create_service(
            ServiceName=name,
            SourceConfiguration=source,
            NetworkConfiguration={
                "IngressConfiguration": {"IsPubliclyAccessible": bool(inputs.get("public", False))}
            },
        )["Service"]
        print(f"creating service '{name}'")

        deadline = time.monotonic() + START_TIMEOUT_SECONDS
        while service.get("Status") == "OPERATION_IN_PROGRESS" and time.monotonic() < deadline:
            time.sleep(POLL_SECONDS)
            service = apprunner.describe_service(ServiceArn=service["ServiceArn"])["Service"]
        if service.get("Status") != "RUNNING":
            return _failure(
                "SERVICE_NOT_RUNNING",
                f"Service '{name}' is {service.get('Status')}; see its events in the App Runner console.",
                retryable=service.get("Status") == "OPERATION_IN_PROGRESS",
            )
    except (ClientError, BotoCoreError) as error:
        return _aws_failure(error)

    print(f"service '{name}' is running")
    _write_result({"status": "succeeded", "outputs": _outputs(service)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
