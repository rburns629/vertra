# SPDX-License-Identifier: MIT
"""Recognizing credentials a step sends back (app/domain/credentials.py)."""

from app.domain.credentials import find_credential, redact_lines, redact_text

# Built up so no scanner mistakes this file for a leak.
AWS = "AKIA" + "ABCDEFGHIJKLMNOP"
GITHUB = "ghp_" + "a1B2" * 9
PEM_BEGIN = "-----BEGIN " + "RSA PRIVATE KEY-----"
PEM_END = "-----END " + "RSA PRIVATE KEY-----"


def test_tokens_are_redacted_in_place() -> None:
    line = f"using key {AWS} and token {GITHUB} for my-bucket"
    assert redact_text(line) == (
        "using key [redacted AWS access key] and token [redacted GitHub token] for my-bucket"
    )


def test_bearer_tokens_and_jwts_are_redacted_from_logs() -> None:
    jwt = "eyJhbGciOiJIUzI1NiJ9" + ".eyJzdWIiOiIxMjM0NTY3ODkwIn0" + ".dozjgNryP4J3jVmNHl0w5N_XgL0n3"
    assert "eyJ" not in redact_text(f"token={jwt}")
    assert redact_text("Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345") == (
        "Authorization: [redacted bearer token]"
    )


def test_a_private_key_spanning_lines_is_replaced_whole() -> None:
    lines = ["starting", f"key: {PEM_BEGIN}", "MIIEowIBAAKCAQEA", "x9y8z7", PEM_END, "done"]
    assert redact_lines(lines) == ["starting", "key: [redacted private key]", "done"]


def test_a_private_key_never_ended_hides_everything_after_it() -> None:
    assert redact_lines(["a", PEM_BEGIN, "MIIE", "more"]) == ["a", "[redacted private key]"]


def test_a_private_key_on_one_line_as_json_escapes_it() -> None:
    sa_key = '{"private_key": "' + PEM_BEGIN + "\\nMIIE\\n" + PEM_END + '\\n", "type": "x"}'
    assert redact_text(sa_key) == '{"private_key": "[redacted private key]\\n", "type": "x"}'


def test_ordinary_output_is_left_alone() -> None:
    ordinary = [
        "Created project my-project-1234 in folder 98765",
        "sha256:" + "a" * 64,
        "https://storage.googleapis.com/bucket/object",
        "AKIA is a prefix, not a key",
    ]
    assert redact_lines(ordinary) == ordinary
    assert find_credential({"projectId": "p-1", "uris": ordinary}) is None


def test_credentials_are_found_anywhere_in_outputs() -> None:
    assert find_credential({"a": {"b": [1, {"c": f"x {AWS}"}]}}) == "AWS access key"
    assert find_credential({GITHUB: True}) == "GitHub token"
    assert find_credential({"serviceAccountKey": f"{PEM_BEGIN}\nMII\n{PEM_END}"}) == "private key"


def test_a_dag_whose_inputs_hold_a_credential_is_refused() -> None:
    import pytest

    from app.contracts.task import TaskDefinition
    from app.domain.dag_validation import validate_dag
    from app.domain.errors import DAGValidationError, ValidationIssueCode

    def task(task_id: str, inputs: dict[str, object]) -> TaskDefinition:
        return TaskDefinition.model_validate(
            {
                "id": task_id,
                "image": "r/app:1",
                "action": "run",
                "team": "t",
                "serviceAccount": "default",
                "inputs": inputs,
            }
        )

    with pytest.raises(DAGValidationError) as refused:
        validate_dag([task("ok", {"bucket": "b"}), task("leaky", {"auth": {"key": AWS}})])
    assert [(i.code, i.task_id) for i in refused.value.issues] == [
        (ValidationIssueCode.INPUT_CONTAINS_CREDENTIAL, "leaky")
    ]
