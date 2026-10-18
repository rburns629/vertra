"""Tests for aws/s3-bucket's create action, with boto3 mocked, so they run
without an AWS account. `./catalogctl check` runs them in the product's own
image with its python3 (unittest, no pytest).
"""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from botocore.exceptions import ClientError

_MODULE_PATH = Path(__file__).parent / "create.py"


def _load_create_module():
    spec = importlib.util.spec_from_file_location("aws_s3_bucket_create", _MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _client_error(code: str, status: int = 400) -> ClientError:
    return ClientError(
        {"Error": {"Code": code, "Message": "test"}, "ResponseMetadata": {"HTTPStatusCode": status}},
        "operation",
    )


class CreateActionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.module = _load_create_module()
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.module.INPUT_PATH = Path(self.tmp_dir.name) / "request.json"
        self.module.OUTPUT_PATH = Path(self.tmp_dir.name) / "result.json"

    def tearDown(self) -> None:
        self.tmp_dir.cleanup()

    def _run(self, inputs: dict) -> tuple[int, dict, object]:
        self.module.INPUT_PATH.write_text(json.dumps({"inputs": inputs}))
        with patch.object(self.module.boto3.session, "Session") as session_cls:
            s3 = session_cls.return_value.client.return_value
            self.configure(s3)
            exit_code = self.module.main()
        return exit_code, json.loads(self.module.OUTPUT_PATH.read_text()), s3

    def configure(self, s3) -> None:  # overridden per test
        pass

    def test_missing_input_fails_without_calling_aws(self) -> None:
        self.module.INPUT_PATH.write_text(json.dumps({"inputs": {"bucketName": "b"}}))
        with patch.object(self.module.boto3.session, "Session") as session_cls:
            self.assertEqual(self.module.main(), 1)
        session_cls.assert_not_called()

    def test_an_existing_bucket_is_left_alone(self) -> None:
        self.configure = lambda s3: setattr(s3.head_bucket, "return_value", {"BucketRegion": "eu-west-1"})
        exit_code, result, s3 = self._run({"bucketName": "b", "region": "eu-west-1"})
        self.assertEqual(exit_code, 0)
        self.assertEqual(result["outputs"], {"bucketName": "b", "region": "eu-west-1", "arn": "arn:aws:s3:::b"})
        s3.create_bucket.assert_not_called()

    def test_a_missing_bucket_is_created_private(self) -> None:
        self.configure = lambda s3: setattr(s3.head_bucket, "side_effect", _client_error("404", 404))
        exit_code, result, s3 = self._run({"bucketName": "b", "region": "eu-west-1"})
        self.assertEqual(exit_code, 0)
        s3.create_bucket.assert_called_once_with(
            Bucket="b", CreateBucketConfiguration={"LocationConstraint": "eu-west-1"}
        )
        block = s3.put_public_access_block.call_args.kwargs["PublicAccessBlockConfiguration"]
        self.assertTrue(all(block.values()))

    def test_us_east_1_gets_no_location_constraint(self) -> None:
        self.configure = lambda s3: setattr(s3.head_bucket, "side_effect", _client_error("404", 404))
        _, _, s3 = self._run({"bucketName": "b", "region": "us-east-1"})
        s3.create_bucket.assert_called_once_with(Bucket="b")

    def test_someone_elses_bucket_is_a_clear_refusal(self) -> None:
        self.configure = lambda s3: setattr(s3.head_bucket, "side_effect", _client_error("403", 403))
        exit_code, result, s3 = self._run({"bucketName": "taken", "region": "eu-west-1"})
        self.assertEqual(exit_code, 1)
        self.assertEqual(result["error"]["code"], "BUCKET_NAME_TAKEN")
        self.assertFalse(result["error"]["retryable"])
        s3.create_bucket.assert_not_called()

    def test_throttling_is_retryable_and_access_denied_isnt(self) -> None:
        for code, status, retryable in (("SlowDown", 503, True), ("AccessDenied", 403, False)):
            def configure(s3, code=code, status=status):
                s3.head_bucket.side_effect = _client_error("404", 404)
                s3.create_bucket.side_effect = _client_error(code, status)
            self.configure = configure
            _, result, _ = self._run({"bucketName": "b", "region": "eu-west-1"})
            self.assertEqual(result["error"]["code"], "AWS_API_ERROR")
            self.assertEqual(result["error"]["retryable"], retryable, code)


if __name__ == "__main__":
    unittest.main()
