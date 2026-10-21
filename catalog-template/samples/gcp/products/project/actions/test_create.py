"""Tests for gcp/project's create action, with the Google Cloud clients
mocked, so they run without a GCP account. `./vertra catalog check` runs them in
the product's own image with its python3 (unittest, no pytest).
"""

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

_MODULE_PATH = Path(__file__).parent / "create.py"


def _load_create_module():
    spec = importlib.util.spec_from_file_location("gcp_project_create", _MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CreateActionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.module = _load_create_module()
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.module.INPUT_PATH = Path(self.tmp_dir.name) / "request.json"
        self.module.OUTPUT_PATH = Path(self.tmp_dir.name) / "result.json"

    def tearDown(self) -> None:
        self.tmp_dir.cleanup()

    def _write_request(self, inputs: dict) -> None:
        self.module.INPUT_PATH.write_text(
            json.dumps(
                {
                    "executionId": "e",
                    "taskId": "t",
                    "action": "create",
                    "attempt": 1,
                    "inputs": inputs,
                }
            )
        )

    def _result(self) -> dict:
        return json.loads(self.module.OUTPUT_PATH.read_text())

    def test_missing_project_id_fails_without_calling_gcp(self) -> None:
        self._write_request({})
        with patch.object(self.module.resourcemanager_v3, "ProjectsClient") as client_cls:
            exit_code = self.module.main()

        client_cls.assert_not_called()
        self.assertEqual(exit_code, 1)
        self.assertEqual(self._result()["error"]["code"], "MISSING_INPUT")

    def test_existing_project_skips_creation(self) -> None:
        self._write_request({"projectId": "already-exists"})
        with patch.object(self.module.resourcemanager_v3, "ProjectsClient") as client_cls:
            client = client_cls.return_value
            client.get_project.return_value = MagicMock()  # found -- no NotFound raised
            exit_code = self.module.main()

        client.get_project.assert_called_once_with(name="projects/already-exists")
        client.create_project.assert_not_called()
        self.assertEqual(exit_code, 0)
        self.assertEqual(
            self._result(), {"status": "succeeded", "outputs": {"projectId": "already-exists"}}
        )

    def test_new_project_is_created_and_billing_linked(self) -> None:
        self._write_request(
            {"projectId": "brand-new", "billingAccountId": "AAAAAA-BBBBBB-CCCCCC"}
        )
        with (
            patch.object(self.module.resourcemanager_v3, "ProjectsClient") as client_cls,
            patch.object(self.module, "CloudBillingClient") as billing_cls,
        ):
            client = client_cls.return_value
            client.get_project.side_effect = self.module.NotFound("no such project")
            client.create_project.return_value.result.return_value = MagicMock()
            billing_client = billing_cls.return_value

            exit_code = self.module.main()

        client.create_project.assert_called_once()
        created_project = client.create_project.call_args.kwargs["project"]
        self.assertEqual(created_project.project_id, "brand-new")

        billing_client.update_project_billing_info.assert_called_once()
        billing_kwargs = billing_client.update_project_billing_info.call_args.kwargs
        self.assertEqual(billing_kwargs["name"], "projects/brand-new")
        self.assertEqual(
            billing_kwargs["project_billing_info"].billing_account_name,
            "billingAccounts/AAAAAA-BBBBBB-CCCCCC",
        )
        self.assertEqual(exit_code, 0)
        self.assertEqual(
            self._result(), {"status": "succeeded", "outputs": {"projectId": "brand-new"}}
        )

    def test_new_project_without_billing_account_skips_billing_call(self) -> None:
        self._write_request({"projectId": "brand-new-no-billing"})
        with (
            patch.object(self.module.resourcemanager_v3, "ProjectsClient") as client_cls,
            patch.object(self.module, "CloudBillingClient") as billing_cls,
        ):
            client = client_cls.return_value
            client.get_project.side_effect = self.module.NotFound("no such project")
            client.create_project.return_value.result.return_value = MagicMock()

            exit_code = self.module.main()

        billing_cls.assert_not_called()
        self.assertEqual(exit_code, 0)

    def test_get_project_api_error_is_a_retryable_failure(self) -> None:
        self._write_request({"projectId": "whatever"})
        with patch.object(self.module.resourcemanager_v3, "ProjectsClient") as client_cls:
            client = client_cls.return_value
            client.get_project.side_effect = self.module.GoogleAPIError("transient")
            exit_code = self.module.main()

        self.assertEqual(exit_code, 1)
        result = self._result()
        self.assertEqual(result["error"]["code"], "GCP_API_ERROR")
        self.assertTrue(result["error"]["retryable"])

    def test_create_project_api_error_is_a_retryable_failure(self) -> None:
        self._write_request({"projectId": "whatever"})
        with patch.object(self.module.resourcemanager_v3, "ProjectsClient") as client_cls:
            client = client_cls.return_value
            client.get_project.side_effect = self.module.NotFound("no such project")
            client.create_project.side_effect = self.module.GoogleAPIError("quota exceeded")
            exit_code = self.module.main()

        self.assertEqual(exit_code, 1)
        result = self._result()
        self.assertEqual(result["error"]["code"], "GCP_API_ERROR")
        self.assertTrue(result["error"]["retryable"])


class BuildCredentialsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.module = _load_create_module()

    def test_returns_none_when_target_env_var_unset(self) -> None:
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop(self.module.TARGET_SERVICE_ACCOUNT_ENV_VAR, None)
            self.assertIsNone(self.module._build_credentials())

    def test_impersonates_target_when_env_var_set(self) -> None:
        target = "kernel-gcp-test@my-project.iam.gserviceaccount.com"
        with (
            patch.dict(os.environ, {self.module.TARGET_SERVICE_ACCOUNT_ENV_VAR: target}),
            patch.object(self.module.google.auth, "default") as default_mock,
            patch.object(self.module.impersonated_credentials, "Credentials") as creds_cls,
        ):
            source_credentials = MagicMock()
            default_mock.return_value = (source_credentials, "some-project")

            result = self.module._build_credentials()

        default_mock.assert_called_once()
        creds_cls.assert_called_once_with(
            source_credentials=source_credentials,
            target_principal=target,
            target_scopes=self.module.IMPERSONATION_SCOPES,
        )
        self.assertEqual(result, creds_cls.return_value)

    def test_impersonated_credentials_are_passed_to_gcp_clients(self) -> None:
        """Proves the wiring end-to-end, not just the helper in isolation:
        when impersonation is configured, main() must actually pass the
        resulting credentials to every client it constructs -- a helper
        that works correctly but never gets used would still be a bug."""
        target = "kernel-gcp-test@my-project.iam.gserviceaccount.com"
        with (
            patch.dict(os.environ, {self.module.TARGET_SERVICE_ACCOUNT_ENV_VAR: target}),
            patch.object(self.module.google.auth, "default") as default_mock,
            patch.object(self.module.impersonated_credentials, "Credentials") as creds_cls,
            patch.object(self.module.resourcemanager_v3, "ProjectsClient") as client_cls,
        ):
            default_mock.return_value = (MagicMock(), "some-project")
            client_cls.return_value.get_project.return_value = MagicMock()

            self.module.INPUT_PATH = Path(tempfile.mkstemp()[1])
            self.module.OUTPUT_PATH = Path(tempfile.mkstemp()[1])
            self.module.INPUT_PATH.write_text(
                json.dumps(
                    {
                        "executionId": "e",
                        "taskId": "t",
                        "action": "create",
                        "attempt": 1,
                        "inputs": {"projectId": "already-exists"},
                    }
                )
            )

            self.module.main()

        client_cls.assert_called_once_with(credentials=creds_cls.return_value)


if __name__ == "__main__":
    unittest.main()
