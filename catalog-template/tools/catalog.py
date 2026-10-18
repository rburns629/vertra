# SPDX-License-Identifier: MIT
"""Validates, builds, tests, scans and publishes this catalog's products.

The one implementation behind both ways of publishing: CI workflows call it,
and so does a laptop in local mode (./catalogctl publish, or make
catalog-publish in the platform repository). Settings come from acyclix.yaml
at the repository root, overridable by environment variables.

    ./catalogctl validate [PRODUCT ...]   product.yaml and team.yaml, tests present
    ./catalogctl check    [PRODUCT ...]   validate, build, test and scan: what a PR runs
    ./catalogctl publish  [PRODUCT ...]   check, then push, sign and register
    ./catalogctl changed  --base REF      the products changed since REF, as JSON

    ./catalogctl teams apply [TEAM ...] [--changed REF]   make each team exist and be active
    ./catalogctl teams retire [TEAM ...] [--removed-since REF]
    ./catalogctl teams purge TEAM                         irreversible; the folder must be gone
    ./catalogctl teams changed --base REF                     teams changed since REF, as JSON
    ./catalogctl secret-stores check [TEAM ...]
    ./catalogctl secret-stores apply [TEAM ...]               BOOTSTRAP_CREDENTIAL: a stored credential
    ./catalogctl bases [--update]          pin every Dockerfile's FROM to its digest

The team and secret-store commands only call the console (its token in
ACYCLIX_TOKEN): the console creates, retires and purges team namespaces and
applies SecretStores, so neither CI nor a laptop needs cluster credentials.

PRODUCT is a product's folder (teams/<team>/products/<product>); none means
every product. --changed REF picks the products changed since REF instead.

A product's image is <registry>/<team>/<product>, from its folder, so
no product can publish under another team's name. It's registered with
the console by digest, one registration per action, carrying everything in
product.yaml the console uses.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import jsonschema
import yaml

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / "tools"

# Scanners run from these images when they aren't installed (a laptop).
# CI installs checksum-pinned binaries instead (.github/scripts/install-scanners.sh),
# at the same versions.
TRIVY_IMAGE = (
    "aquasec/trivy:0.74.0"
    "@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969"
)
OSV_SCANNER_IMAGE = (
    "ghcr.io/google/osv-scanner:v2.6.0"
    "@sha256:afd838850ac1a0fcc15ff4a041dc9ba11123c3f0d2666217a5f0fcf9222b55fa"
)
# Trivy's vulnerability database, kept between local runs.
TRIVY_CACHE_VOLUME = "acyclix-trivy-cache"

CONTRACT_TEST_TIMEOUT_SECONDS = 300


# --- Output -----------------------------------------------------------------

IN_GITHUB = os.environ.get("GITHUB_ACTIONS") == "true"


def error(message: str, path: Path | None = None) -> None:
    if IN_GITHUB:
        where = f" file={path.relative_to(ROOT)}" if path else ""
        print(f"::error{where}::{message}")
    else:
        where = f"{path.relative_to(ROOT)}: " if path else ""
        print(f"ERROR: {where}{message}", file=sys.stderr)


def info(message: str) -> None:
    print(message, flush=True)


class group:  # lower case: it reads as a statement, `with group(...)`
    """A collapsible section in a GitHub Actions log; a heading elsewhere."""

    def __init__(self, title: str) -> None:
        self.title = title

    def __enter__(self) -> None:
        print(f"::group::{self.title}" if IN_GITHUB else f"\n== {self.title}", flush=True)

    def __exit__(self, *_: object) -> None:
        if IN_GITHUB:
            print("::endgroup::", flush=True)


def summary(markdown: str) -> None:
    """Appends to the GitHub Actions run summary, when there is one."""
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a") as out:
            out.write(markdown + "\n")


# --- Settings ---------------------------------------------------------------


@dataclass(frozen=True)
class Settings:
    registry: str
    console: str
    signing_mode: str
    signing_key: str

    @classmethod
    def load(cls) -> Settings:
        path = ROOT / "acyclix.yaml"
        data: dict[str, Any] = (yaml.safe_load(path.read_text()) or {}) if path.exists() else {}
        signing = data.get("signing") or {}
        return cls(
            registry=os.environ.get("ACYCLIX_REGISTRY") or str(data.get("registry") or ""),
            console=os.environ.get("ACYCLIX_CONSOLE_URL") or str(data.get("console") or ""),
            signing_mode=os.environ.get("ACYCLIX_SIGNING_MODE") or str(signing.get("mode") or "none"),
            signing_key=os.environ.get("ACYCLIX_SIGNING_KEY") or str(signing.get("key") or ""),
        )

    def problems(self) -> list[str]:
        found = []
        if not self.registry:
            found.append("no registry: set registry in acyclix.yaml or ACYCLIX_REGISTRY")
        elif "://" in self.registry or self.registry.endswith("/"):
            found.append(f"registry {self.registry!r}: a path like host[:port]/path, no scheme or trailing /")
        if not self.console:
            found.append("no console: set console in acyclix.yaml or ACYCLIX_CONSOLE_URL")
        if self.signing_mode not in ("none", "key", "keyless"):
            found.append(f"signing mode {self.signing_mode!r}: one of none, key, keyless")
        if self.signing_mode == "key" and not self.signing_key:
            found.append("signing mode key needs a key: signing.key or ACYCLIX_SIGNING_KEY")
        return found


# --- Products ---------------------------------------------------------------


@dataclass
class Product:
    directory: Path
    spec: dict[str, Any] = field(default_factory=dict)

    @property
    def is_template(self) -> bool:
        return self.directory.parent.name == "templates"

    @property
    def team(self) -> str:
        # A template stands in for whichever team copies it.
        # teams/<team>/products/<product>
        return "templates" if self.is_template else self.directory.parent.parent.name

    @property
    def name(self) -> str:
        return self.directory.name

    @property
    def label(self) -> str:
        return str(self.directory.relative_to(ROOT))

    @property
    def local_image(self) -> str:
        return f"acyclix-catalog/{self.team}/{self.name}:ci"

    def repository(self, settings: Settings) -> str:
        return f"{settings.registry}/{self.team}/{self.name}"

    def actions(self) -> list[dict[str, Any]]:
        return list(self.spec.get("actions") or [])


def all_products() -> list[Product]:
    found = sorted(ROOT.glob("teams/*/products/*/product.yaml")) + sorted(
        ROOT.glob("templates/*/product.yaml")
    )
    return [Product(path.parent) for path in found]


def select_products(names: list[str], changed_since: str | None) -> list[Product]:
    products = all_products()
    if changed_since is not None:
        wanted = set(changed_products(changed_since, products))
        return [p for p in products if p.label in wanted]
    if not names:
        return products
    by_dir = {p.directory: p for p in products}
    chosen = []
    for name in names:
        directory = (Path.cwd() / name).resolve()
        if directory not in by_dir:
            raise SystemExit(f"Not a product folder (no product.yaml): {name}")
        chosen.append(by_dir[directory])
    return chosen


def git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=ROOT, check=True, capture_output=True, text=True
    ).stdout


def changed_products(base: str, products: list[Product]) -> list[str]:
    """Product folders changed between `base` and HEAD.

    Everything, when there's no usable base (a first push, a force-push, a
    manual run) rather than silently nothing, and when this tooling itself
    changed: a new check applies to every product.
    """
    labels = [p.label for p in products]
    if not base or set(base) == {"0"}:
        return labels
    try:
        git("cat-file", "-e", f"{base}^{{commit}}")
        names = git("diff", "--name-only", base, "HEAD").splitlines()
    except subprocess.CalledProcessError:
        return labels
    if any(n.startswith(("tools/", "acyclix.yaml")) for n in names):
        return labels
    return [label for label in labels if any(n.startswith(label + "/") for n in names)]


# --- Validate ---------------------------------------------------------------


def _schema(name: str) -> jsonschema.protocols.Validator:
    schema = json.loads((TOOLS / name).read_text())
    return jsonschema.Draft202012Validator(schema)


def _schema_errors(validator: jsonschema.protocols.Validator, data: Any) -> list[str]:
    def where(e: jsonschema.ValidationError) -> str:
        return ".".join(str(p) for p in e.absolute_path) or "(top level)"

    return [f"{where(e)}: {e.message}" for e in validator.iter_errors(data)]


def _load_yaml(path: Path) -> tuple[Any, str | None]:
    try:
        return yaml.safe_load(path.read_text()), None
    except yaml.YAMLError as e:
        return None, f"not valid YAML: {e}"


# What a team folder may hold, besides team.yaml.
TEAM_ENTRIES = {"team.yaml", "README.md", "products", "secret-stores", "dags"}


def team_dirs() -> list[Path]:
    folder = ROOT / "teams"
    return sorted(p for p in folder.iterdir() if p.is_dir()) if folder.is_dir() else []


# Catalogs before 2026-10-18 called a team a platform.
RENAMED = "teams were called platforms until 2026-10-18"


def validate_teams() -> bool:
    ok = True
    if (ROOT / "platforms").exists():
        error(f"rename platforms/ to teams/, and each platform.yaml to team.yaml ({RENAMED})",
              ROOT / "platforms")
        ok = False
    validator = _schema("team.schema.json")
    for directory in team_dirs():
        path = directory / "team.yaml"
        if not path.exists():
            error("every team folder needs a team.yaml (see templates/team)", path)
            ok = False
            continue
        data, problem = _load_yaml(path)
        problems = [problem] if problem else _schema_errors(validator, data)
        if not problems and data["name"] != directory.name:
            problems.append(f"name {data['name']!r} isn't the folder's name, {directory.name!r}")
        for p in problems:
            error(p, path)
        ok = ok and not problems
        for entry in sorted(directory.iterdir()):
            if entry.name == "platform.yaml":
                error(f"rename it to team.yaml ({RENAMED})", entry)
                ok = False
            elif entry.name not in TEAM_ENTRIES:
                error(f"a team folder holds only {', '.join(sorted(TEAM_ENTRIES))}", entry)
                ok = False
        products = directory / "products"
        for child in sorted(c for c in products.iterdir()) if products.is_dir() else []:
            if not (child / "product.yaml").exists():
                error("everything in products/ is a product folder, with a product.yaml", child)
                ok = False
    return ok


# Paths only the catalog admins (the fallback's owners) may approve: what
# CI runs and publishes with, the starters, and SecretStores.
ADMIN_PATHS = (".github/CODEOWNERS", ".github/workflows/ci.yml", "tools/catalog.py",
               "acyclix.yaml", "catalogctl", "templates/hello/product.yaml",
               "teams/x/secret-stores/secretstore.yaml")
# A team's own line: /teams/<team>/.
TEAM_LINE = re.compile(r"^/teams/[^/*]+/?$")
CODEOWNERS_OWNER = re.compile(r"^@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:/[A-Za-z0-9._-]+)?$|^[^@\s]+@[^@\s]+$")


def _codeowners_matches(pattern: str, path: str) -> bool:
    """The patterns this catalog uses: *, /dir/ and /file (or /dir), where a
    whole segment may be * (any one folder)."""
    if pattern == "*":
        return True
    wanted = pattern.strip("/").split("/")
    parts = path.split("/")
    if len(parts) < len(wanted):
        return False
    return all(w == "*" or w == part for w, part in zip(wanted, parts))


def codeowners_rules(path: Path) -> tuple[list[tuple[str, list[str]]], list[str]]:
    rules, problems = [], []
    for number, line in enumerate(path.read_text().splitlines(), 1):
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        pattern, *owners = line.split()
        segments = pattern.strip("/").split("/")
        if pattern != "*" and not (pattern.startswith("/") and all(s == "*" or "*" not in s for s in segments)):
            problems.append(f"line {number}: {pattern!r}: use *, /folder/ or /file, with * only as a whole folder "
                            "(keeps ownership easy to check)")
        for owner in owners:
            if not CODEOWNERS_OWNER.match(owner):
                problems.append(f"line {number}: {owner!r} isn't a @user, @org/team or email")
        rules.append((pattern, owners))
    return rules, problems


def owners_of(rules: list[tuple[str, list[str]]], path: str) -> list[str]:
    """GitHub's rule: the last matching line wins, even with no owners."""
    owners: list[str] = []
    for pattern, line_owners in rules:
        if _codeowners_matches(pattern, path):
            owners = line_owners
    return owners


def validate_codeowners() -> bool:
    """One .github/CODEOWNERS; every team owned; admin paths admin-owned."""
    path = ROOT / ".github" / "CODEOWNERS"
    problems = []
    for ignored in (ROOT / "CODEOWNERS", ROOT / "docs" / "CODEOWNERS"):
        if ignored.exists():
            error("GitHub only reads .github/CODEOWNERS when it exists, so this file is ignored: "
                  "move its lines there", ignored)
            problems.append("ignored file")
    if not path.exists():
        error("no .github/CODEOWNERS: without it, anyone with write access can merge any change", path)
        return False
    rules, found = codeowners_rules(path)
    problems += found
    admins = sorted(owners_of(rules, "any/other/path"))
    if not rules or rules[0][0] != "*" or not admins:
        error("the first line must be the fallback, * followed by the catalog admins", path)
        return False
    for team in team_names():
        line = next((owners for pattern, owners in rules if pattern.rstrip("/") == f"/teams/{team}"), None)
        if not line:
            problems.append(f"no owners for teams/{team}/: add a line /teams/{team}/ @<its owners>")
    for pattern, owners in rules:
        folder = ROOT / pattern.lstrip("/")
        if TEAM_LINE.match(pattern) and not folder.exists():
            problems.append(f"{pattern}: no such folder (a removed team's line? delete it)")
        if sorted(owners) != admins and not TEAM_LINE.match(pattern):
            problems.append(f"{pattern}: only the catalog admins ({' '.join(admins)}) may own paths other than "
                            "a team's folder")
    for admin_path in ADMIN_PATHS:
        if sorted(owners_of(rules, admin_path)) != admins:
            problems.append(f"{admin_path} must be owned by the catalog admins ({' '.join(admins)}), as the "
                            "fallback is: a later line gives it to someone else")
    for p in problems:
        if p != "ignored file":
            error(p, path)
    return not problems


def validate_product(product: Product) -> bool:
    path = product.directory / "product.yaml"
    data, problem = _load_yaml(path)
    problems: list[str] = []
    if problem:
        problems.append(problem)
    elif isinstance(data, dict) and "image" in data:
        problems.append(
            "remove image: a product's image is derived from its folder, "
            "<registry>/<team>/" + product.name
        )
    elif isinstance(data, dict) and "platform" in data:
        problems.append(f"rename platform: to team: ({RENAMED})")
    if not problems:
        problems = _schema_errors(_schema("product.schema.json"), data)
    if not problems:
        product.spec = data
        if data["name"] != product.name:
            problems.append(f"name {data['name']!r} isn't the folder's name, {product.name!r}")
        if not product.is_template and data["team"] != product.team:
            problems.append(
                f"team {data['team']!r} isn't the parent folder's name, {product.team!r}"
            )
        names = [a["name"] for a in product.actions()]
        if len(set(names)) != len(names):
            problems.append("two actions have the same name")
        for action in product.actions():
            secrets = [s["name"] for s in action.get("requiredSecrets") or []]
            if len(set(secrets)) != len(secrets):
                problems.append(f"action {action['name']}: a secret is listed twice in requiredSecrets")
            for side in ("input", "output"):
                try:
                    jsonschema.Draft202012Validator.check_schema(action[side])
                except jsonschema.SchemaError as e:
                    problems.append(f"action {action['name']}: {side} isn't a valid JSON Schema: {e.message}")
        problems += _test_layout_problems(product, set(names))
    if not (product.directory / "Dockerfile").exists():
        problems.append("no Dockerfile")
    else:
        problems += _base_problems(product.directory / "Dockerfile")
    for p in problems:
        error(p, path)
    return not problems


def _test_layout_problems(product: Product, actions: set[str]) -> list[str]:
    problems = []
    for case in contract_cases(product):
        if case.action not in actions:
            problems.append(f"tests/{case.action}/: no action named {case.action!r}")
        for name in ("request.json", "expected.json"):
            try:
                json.loads((case.directory / name).read_text())
            except FileNotFoundError:
                problems.append(f"{case.label}: no {name}")
            except json.JSONDecodeError as e:
                problems.append(f"{case.label}/{name}: not valid JSON: {e}")
    if not contract_cases(product) and not python_tests(product):
        problems.append(
            "no tests: add tests/<action>/<case>/{request.json,expected.json} (see templates/hello)"
        )
    return problems


# --- Base images --------------------------------------------------------------
#
# Every FROM names its base by digest (`python:3.12-slim@sha256:…`), so a
# build is the same bytes until someone deliberately moves it:
# `./catalogctl bases --update` re-pins each tag to what it names now.

FROM_LINE = re.compile(r"^(FROM\s+(?:--platform=\S+\s+)?)(\S+)(.*)$", re.IGNORECASE)


def dockerfiles() -> list[Path]:
    # samples/ too: never published from there, but copied as starters.
    return sorted(ROOT.glob("teams/*/products/*/Dockerfile")) + sorted(ROOT.glob("templates/*/Dockerfile")) + sorted(
        ROOT.glob("samples/*/products/*/Dockerfile")
    )


def _base_problems(path: Path) -> list[str]:
    stages: set[str] = set()
    problems = []
    for number, line in enumerate(path.read_text().splitlines(), 1):
        match = FROM_LINE.match(line.strip())
        if not match:
            continue
        image, rest = match.group(2), match.group(3)
        alias = rest.split()[-1].lower() if " as " in f" {rest.lower()} " else None
        if image.lower() not in stages and image != "scratch" and "@sha256:" not in image:
            problems.append(f"Dockerfile line {number}: base image {image} isn't pinned by digest: run ./catalogctl bases")
        if alias:
            stages.add(alias)
    return problems


def _digest_of(image: str) -> str:
    out = docker("buildx", "imagetools", "inspect", image, "--format", "{{json .Manifest.Digest}}",
                 capture=True).stdout
    digest = json.loads(out)
    if not isinstance(digest, str) or not digest.startswith("sha256:"):
        raise RuntimeError(f"no digest for {image}: {out[:200]}")
    return digest


def bases(update: bool) -> int:
    """Pins every unpinned FROM to its tag's current digest; with `update`,
    re-pins the pinned ones too."""
    changed = 0
    digests: dict[str, str] = {}
    for path in dockerfiles():
        lines = path.read_text().splitlines(keepends=True)
        stages: set[str] = set()
        for i, line in enumerate(lines):
            match = FROM_LINE.match(line.rstrip("\n").strip())
            if not match:
                continue
            prefix, image, rest = match.groups()
            if " as " in f" {rest.lower()} ":
                stages.add(rest.split()[-1].lower())
            if image.lower() in stages or image == "scratch" or ("@sha256:" in image and not update):
                continue
            tag = image.split("@", 1)[0]
            if tag not in digests:
                digests[tag] = _digest_of(tag)
            pinned = f"{tag}@{digests[tag]}"
            if pinned != image:
                lines[i] = f"{prefix}{pinned}{rest}\n"
                changed += 1
                info(f"  {path.relative_to(ROOT)}: {pinned}")
        path.write_text("".join(lines))
    info(f"{changed} base image(s) pinned.")
    return 0


# --- Docker -----------------------------------------------------------------


def docker_binary() -> str:
    for candidate in (
        os.environ.get("DOCKER"),
        shutil.which("docker"),
        "/Applications/Docker.app/Contents/Resources/bin/docker",
    ):
        if candidate and Path(candidate).exists():
            return candidate
    raise SystemExit("docker not found: install it, or set DOCKER to its path")


def docker(*args: str, check: bool = True, capture: bool = False, timeout: float | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [docker_binary(), *args], check=check, text=True, capture_output=capture, timeout=timeout
    )


def build(product: Product) -> bool:
    # --pull: build on the base image's current patch level, not a cached one.
    result = docker("build", "--pull", "-t", product.local_image, str(product.directory), check=False)
    if result.returncode != 0:
        error("docker build failed", product.directory)
    return result.returncode == 0


# --- Test -------------------------------------------------------------------


@dataclass(frozen=True)
class ContractCase:
    directory: Path

    @property
    def action(self) -> str:
        return self.directory.parent.name

    @property
    def label(self) -> str:
        return f"tests/{self.action}/{self.directory.name}"


def contract_cases(product: Product) -> list[ContractCase]:
    return [ContractCase(d) for d in sorted((product.directory / "tests").glob("*/*")) if d.is_dir()]


def python_tests(product: Product) -> list[Path]:
    return sorted((product.directory / "actions").glob("test_*.py"))


def contains(actual: Any, expected: Any) -> bool:
    """Whether `actual` has everything `expected` has: objects may carry
    more keys (an error's message, say); everything else must be equal."""
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(
            k in actual and contains(actual[k], v) for k, v in expected.items()
        )
    return bool(actual == expected and type(actual) is type(expected))


def run_contract_case(product: Product, case: ContractCase, action: dict[str, Any]) -> list[str]:
    """Runs one case the way the kernel runs a step: request.json mounted at
    /platform/input, the action as the container's argument, result.json
    read back from /platform/output, and the case's secrets/<name>/<key>
    files, if any, at /platform/secrets. No network: a test must not depend
    on (or change) anything outside the container."""
    request = json.loads((case.directory / "request.json").read_text())
    expected = json.loads((case.directory / "expected.json").read_text())
    full_request = {
        "executionId": "contract-test",
        "taskId": case.directory.name,
        "action": case.action,
        "attempt": 1,
        "inputs": {},
        **request,
    }
    with tempfile.TemporaryDirectory(prefix="acyclix-test-") as work:
        input_dir, output_dir = Path(work, "input"), Path(work, "output")
        input_dir.mkdir()
        output_dir.mkdir()
        (input_dir / "request.json").write_text(json.dumps(full_request))
        # The image's own user (often non-root) writes the result.
        for d in (Path(work), input_dir, output_dir):
            d.chmod(0o777 if d == output_dir else 0o755)
        (input_dir / "request.json").chmod(0o644)
        mounts = ["-v", f"{input_dir}:/platform/input:ro", "-v", f"{output_dir}:/platform/output"]
        secrets = case.directory / "secrets"
        if secrets.is_dir():
            mounts += ["-v", f"{secrets.resolve()}:/platform/secrets:ro"]
        try:
            run = docker(
                "run", "--rm", "--network", "none", *mounts, product.local_image, case.action,
                check=False, capture=True, timeout=CONTRACT_TEST_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired:
            return [f"timed out after {CONTRACT_TEST_TIMEOUT_SECONDS}s"]
        result_path = output_dir / "result.json"
        if not result_path.exists():
            return [f"wrote no /platform/output/result.json (exit {run.returncode}): {run.stderr.strip()[-500:]}"]
        try:
            result = json.loads(result_path.read_text())
        except json.JSONDecodeError as e:
            return [f"result.json isn't valid JSON: {e}"]

    problems = []
    # A step's result is readable by anyone who can read the execution, so
    # it must never carry a secret it was given.
    if secrets.is_dir():
        text = json.dumps(result)
        for secret_file in sorted(f for f in secrets.rglob("*") if f.is_file()):
            value = secret_file.read_text(errors="replace").strip()
            if value and value in text:
                problems.append(f"result.json contains the value of secrets/{secret_file.relative_to(secrets)}")
    if not contains(result, expected):
        problems.append(f"result.json {json.dumps(result)} doesn't contain expected.json {json.dumps(expected)}")
    if result.get("status") == "succeeded":
        # A success must also keep the action's declared contract both ways.
        input_errors = _schema_errors(jsonschema.Draft202012Validator(action["input"]), full_request["inputs"])
        output_errors = _schema_errors(
            jsonschema.Draft202012Validator(action["output"]), result.get("outputs", {})
        )
        problems += [f"succeeded on inputs its input schema refuses: {e}" for e in input_errors]
        problems += [f"outputs don't match its output schema: {e}" for e in output_errors]
    return problems


def test(product: Product) -> bool:
    ok = True
    actions = {a["name"]: a for a in product.actions()}
    for case in contract_cases(product):
        problems = run_contract_case(product, case, actions[case.action])
        info(f"  {'FAIL' if problems else 'ok  '} {case.label}")
        for p in problems:
            error(f"{case.label}: {p}", product.directory)
        ok = ok and not problems
    for test_file in python_tests(product):
        # Older products' tests: Python files run inside the product's own
        # image, which must have python3.
        run = docker(
            "run", "--rm", "--network", "none", "--entrypoint", "python3",
            "-v", f"{(product.directory / 'actions').resolve()}:/app/actions:ro",
            product.local_image, f"/app/actions/{test_file.name}", check=False,
        )
        info(f"  {'FAIL' if run.returncode else 'ok  '} actions/{test_file.name}")
        if run.returncode:
            error(f"actions/{test_file.name} failed", product.directory)
            ok = False
    return ok


# --- Scan -------------------------------------------------------------------


def _scanner(binary: str, image: str, work: Path, args: list[str], cache: bool = False) -> list[str]:
    """The command to run a scanner: installed, or else from its pinned image,
    with `work` (holding the image archive) mounted at the same path."""
    if shutil.which(binary):
        return [binary, *args]
    volumes = ["-v", f"{work}:{work}"]
    if cache:
        volumes += ["-v", f"{TRIVY_CACHE_VOLUME}:/root/.cache"]
    return [docker_binary(), "run", "--rm", *volumes, image, *args]


def scan(product: Product) -> bool:
    """Blocks a fixable HIGH or CRITICAL vulnerability, a secret baked into
    the image, or a known-malicious package. Unfixable vulnerabilities are
    reported, not blocking. An accepted vulnerability goes in the product's
    .trivyignore, one id per line with a comment saying why; its review is
    what accepts it."""
    with tempfile.TemporaryDirectory(prefix="acyclix-scan-") as tmp:
        work = Path(tmp).resolve()
        archive = work / "image.tar"
        docker("save", product.local_image, "-o", str(archive))
        trivy_args = ["image", "--input", str(archive), "--quiet", "--scanners", "vuln,secret",
                      "--format", "json", "--output", str(work / "trivy.json")]
        ignore = product.directory / ".trivyignore"
        if ignore.exists():
            shutil.copy(ignore, work / ".trivyignore")
            trivy_args += ["--ignorefile", str(work / ".trivyignore")]
        trivy = subprocess.run(_scanner("trivy", TRIVY_IMAGE, work, trivy_args, cache=True), check=False)
        osv = subprocess.run(
            _scanner("osv-scanner", OSV_SCANNER_IMAGE, work, [
                "scan", "image", "--archive", str(archive),
                "--format", "json", "--output", str(work / "osv.json"),
            ]),
            check=False, capture_output=True, text=True,
        )
        lines = [f"### Security scan: `{product.label}`", ""]
        ok = True
        if trivy.returncode != 0 or not (work / "trivy.json").exists():
            lines.append("- :x: Trivy couldn't scan the image.")
            error("Trivy couldn't scan the image", product.directory)
            ok = False
        else:
            ok = _trivy_verdict(product, json.loads((work / "trivy.json").read_text()), lines) and ok
        # osv-scanner exits non-zero for any known vulnerability, so its
        # report, not its exit code, is the verdict; no report blocks.
        osv_report = work / "osv.json"
        if not osv_report.exists() or osv_report.stat().st_size == 0:
            lines.append("- :x: OSV-Scanner couldn't scan the image.")
            error(f"OSV-Scanner couldn't scan the image: {(osv.stderr or osv.stdout)[-500:]}", product.directory)
            ok = False
        else:
            ok = _osv_verdict(product, json.loads(osv_report.read_text()), lines) and ok
    summary("\n".join(lines) + "\n")
    return ok


def _trivy_verdict(product: Product, report: dict[str, Any], lines: list[str]) -> bool:
    blocking, unfixed, secrets = [], 0, []
    for result in report.get("Results") or []:
        for v in result.get("Vulnerabilities") or []:
            if v["Severity"] in ("HIGH", "CRITICAL"):
                if v.get("FixedVersion"):
                    blocking.append(v)
                else:
                    unfixed += 1
        for s in result.get("Secrets") or []:
            secrets.append((result.get("Target", ""), s.get("RuleID"), s.get("Title")))
    if blocking:
        lines += [f"- :x: {len(blocking)} HIGH/CRITICAL vulnerabilities with a fix available:", "",
                  "  | Severity | Package | Installed | Fixed in | ID |", "  |---|---|---|---|---|"]
        for v in sorted(blocking, key=lambda v: (v["Severity"] != "CRITICAL", v["PkgName"])):
            lines.append(f"  | {v['Severity']} | {v['PkgName']} | {v.get('InstalledVersion', '')} "
                         f"| {v['FixedVersion']} | {v['VulnerabilityID']} |")
            error(f"{v['Severity']} {v['VulnerabilityID']} in {v['PkgName']} "
                  f"{v.get('InstalledVersion', '')} (fixed in {v['FixedVersion']})", product.directory)
        lines += ["", ("  Rebuilding on a fresh base usually fixes these (`apt-get upgrade` for "
                       "OS packages, a newer pin for language packages).")]
    else:
        lines.append("- :white_check_mark: No HIGH/CRITICAL vulnerability with a fix available.")
    if unfixed:
        lines.append(f"- :information_source: {unfixed} HIGH/CRITICAL with no fix yet (reported, not blocking).")
    if secrets:
        lines.append(f"- :x: {len(secrets)} secret(s) baked into the image:")
        for target, rule, title in secrets:
            lines.append(f"  - `{target}`: {title} ({rule})")
            error(f"secret in {target}: {title} ({rule})", product.directory)
    else:
        lines.append("- :white_check_mark: No secrets in the image.")
    info(f"  Trivy: {len(blocking)} fixable HIGH/CRITICAL, {unfixed} unfixable (not blocking), "
         f"{len(secrets)} secret(s)")
    return not blocking and not secrets


def _osv_verdict(product: Product, report: dict[str, Any], lines: list[str]) -> bool:
    malicious = sorted({
        (p["package"]["name"], p["package"].get("version", ""), v["id"])
        for r in report.get("results") or []
        for p in r.get("packages") or []
        for v in p.get("vulnerabilities") or []
        if v["id"].startswith("MAL-")
    })
    if malicious:
        lines.append(f"- :x: {len(malicious)} known-malicious package(s):")
        for name, version, mal_id in malicious:
            lines.append(f"  - `{name} {version}`: [{mal_id}](https://osv.dev/vulnerability/{mal_id})")
            error(f"known-malicious package {name} {version} ({mal_id})", product.directory)
    else:
        lines.append("- :white_check_mark: No known-malicious packages.")
    info(f"  OSV-Scanner: {len(malicious)} known-malicious package(s)")
    return not malicious


# --- Publish ----------------------------------------------------------------


def version_tag() -> str:
    """CI tags with the commit; a laptop with the time (no commit need exist).
    Either way the registration pins the digest, not the tag."""
    return os.environ.get("GITHUB_SHA") or time.strftime("local-%Y%m%dT%H%M%SZ", time.gmtime())


def push(product: Product, settings: Settings) -> str:
    """Pushes the checked image, tagged with its version and `latest` (so a
    DAG can name `<registry>/<team>/<product>:latest`; the console pins
    whatever that names to its digest at submission). Returns the digest
    reference, which is what's registered."""
    repository = product.repository(settings)
    tagged = f"{repository}:{version_tag()}"
    docker("tag", product.local_image, tagged)
    docker("push", tagged)
    docker("tag", product.local_image, f"{repository}:latest")
    docker("push", f"{repository}:latest")
    digests = json.loads(docker("inspect", "--format", "{{json .RepoDigests}}", tagged, capture=True).stdout)
    for reference in digests or []:
        if reference.startswith(repository + "@sha256:"):
            info(f"  pushed {tagged} -> {reference}")
            return str(reference)
    raise RuntimeError(f"pushed {tagged} but found no digest for it")


def sign(reference: str, settings: Settings) -> None:
    """Signs by digest: a tag can move, a digest is the bytes that passed."""
    if settings.signing_mode == "none":
        return
    if not shutil.which("cosign"):
        raise RuntimeError("signing needs cosign installed (.github/scripts/install-scanners.sh cosign)")
    if settings.signing_mode == "key":
        # No public transparency log: verification uses the public key. The
        # legacy signature format, which policy-controller reads.
        args = ["--key", settings.signing_key, "--use-signing-config=false",
                "--tlog-upload=false", "--new-bundle-format=false"]
    else:
        args = ["--new-bundle-format=false"]  # keyless: CI's OIDC identity, logged publicly
    subprocess.run(["cosign", "sign", "--yes", *args, reference], check=True)
    info(f"  signed {reference}")


def console_token(settings: Settings) -> str:
    token = os.environ.get("ACYCLIX_TOKEN")
    if token:
        return token
    email, password = os.environ.get("ACYCLIX_EMAIL"), os.environ.get("ACYCLIX_PASSWORD")
    if email and password:
        # Local mode: sign in as a person instead of minting a bot token.
        response = _post(settings, "/api/auth/login", {"email": email, "password": password}, None)
        return str(response["token"])
    raise RuntimeError(
        "no console credentials: set ACYCLIX_TOKEN (a bot token with products:register), "
        "or ACYCLIX_EMAIL and ACYCLIX_PASSWORD"
    )


def _request(
    settings: Settings, method: str, path: str, body: dict[str, Any] | None, token: str | None
) -> tuple[int, dict[str, Any]]:
    """Calls the console; returns its status and JSON body, whatever the
    status. Retries a request that never got an answer (all of these calls
    are idempotent)."""
    headers = {"Content-Type": "application/json"} if body is not None else {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = json.dumps(body).encode() if body is not None else None
    for attempt in range(1, 5):
        request = urllib.request.Request(settings.console.rstrip("/") + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return response.status, dict(json.loads(response.read() or b"{}"))
        except urllib.error.HTTPError as e:
            text = e.read().decode(errors="replace")
            try:
                return e.code, dict(json.loads(text))
            except ValueError:
                return e.code, {"message": text[:500]}
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt == 4:
                raise RuntimeError(f"{method} {path}: no answer from {settings.console}: {e}") from e
            time.sleep(5 * attempt)
    raise AssertionError("unreachable")


def _post(settings: Settings, path: str, body: dict[str, Any], token: str | None) -> dict[str, Any]:
    status, answer = _request(settings, "POST", path, body, token)
    if status >= 400:
        raise RuntimeError(f"POST {path}: HTTP {status}: {json.dumps(answer)[:500]}")
    return answer


def registrations(product: Product, reference: str) -> Iterator[dict[str, Any]]:
    """One registration per action, named <team>-<product>-<action>."""
    spec = product.spec
    for action in product.actions():
        body: dict[str, Any] = {
            "name": f"{product.team}-{product.name}-{action['name']}",
            "image": reference,
            "action": action["name"],
            "team": product.team,
            "displayName": action.get("displayName") or spec["displayName"],
            "description": action.get("description") or spec["description"],
            "inputSchema": action["input"],
            "outputSchema": action["output"],
            "requiredSecrets": [s["name"] for s in action.get("requiredSecrets") or []],
        }
        if spec.get("serviceAccount"):
            body["serviceAccount"] = spec["serviceAccount"]
        if spec.get("resources"):
            body["resources"] = spec["resources"]
        yield body


def publish(product: Product, settings: Settings, token: str) -> bool:
    try:
        reference = push(product, settings)
        sign(reference, settings)
        for body in registrations(product, reference):
            _post(settings, "/api/products", body, token)
            info(f"  registered {body['name']}")
    except (RuntimeError, subprocess.CalledProcessError) as e:
        error(f"publishing failed: {e}", product.directory)
        return False
    summary(f"- Published `{product.label}` as `{reference}`")
    return True


# --- Teams and secret stores ------------------------------------------------
#
# A team folder is a team: the console gives it a namespace when it's
# applied, relabels it when it's retired, and deletes it when it's purged.


def team_names() -> list[str]:
    return [p.name for p in team_dirs()]


def _usable_base(base: str | None) -> bool:
    if not base or set(base) == {"0"}:
        return False
    try:
        git("cat-file", "-e", f"{base}^{{commit}}")
        return True
    except subprocess.CalledProcessError:
        return False


def teams_changed(base: str | None) -> list[str]:
    """Team folders touched since `base` that still exist; every one
    when there's no usable base (a manual run, a first push)."""
    if not base or not _usable_base(base):
        return team_names()
    touched = {n.split("/")[1] for n in git("diff", "--name-only", base, "HEAD", "--", "teams/").splitlines()
               if n.count("/") >= 2}
    return sorted(p for p in touched if (ROOT / "teams" / p).is_dir())


def teams_removed(base: str | None) -> list[str]:
    """Team folders that existed at `base` and are gone now. None
    without a usable base: never guess at retiring something."""
    if not base or not _usable_base(base):
        return []
    before = git("ls-tree", "-d", "--name-only", base, "teams/").split()  # "teams/<team>"
    return sorted(p.split("/", 1)[1] for p in before if not (ROOT / p).is_dir())


def _console_call(settings: Settings, token: str, method: str, path: str, body: dict[str, Any] | None,
                  ok: tuple[int, ...]) -> tuple[bool, int, dict[str, Any]]:
    status, answer = _request(settings, method, path, body, token)
    return status in ok, status, answer


def teams_apply(names: list[str], settings: Settings, token: str) -> bool:
    ok = True
    for name in names:
        if not (ROOT / "teams" / name / "team.yaml").exists():
            error(f"teams/{name}/ has no team.yaml, so it isn't a team yet", ROOT / "teams" / name)
            ok = False
            continue
        good, status, answer = _console_call(settings, token, "PUT", f"/api/teams/{name}", None, (200, 201))
        if good:
            info(f"  {name}: {'created' if answer.get('created') else 'active'}, with its namespace")
        else:
            error(f"team {name}: HTTP {status}: {answer.get('message', answer)}", ROOT / "teams" / name)
            ok = False
    return ok


def teams_retire(names: list[str], settings: Settings, token: str) -> bool:
    ok = True
    for name in names:
        if (ROOT / "teams" / name).is_dir():
            error(f"teams/{name}/ still exists: a team is retired by removing its folder")
            ok = False
            continue
        good, status, answer = _console_call(settings, token, "POST", f"/api/teams/{name}/retire", None, (200, 404))
        if not good:
            error(f"retiring {name}: HTTP {status}: {answer.get('message', answer)}")
            ok = False
        elif status == 404:
            info(f"  {name}: no such team, nothing to retire")
        else:
            info(f"  {name}: retired ({answer.get('unregisteredProducts', 0)} product(s) unregistered)")
    return ok


def teams_purge(name: str, settings: Settings, token: str) -> bool:
    if (ROOT / "teams" / name).is_dir():
        error(f"teams/{name}/ still exists: remove it in a reviewed pull request first, which retires it")
        return False
    good, status, answer = _console_call(settings, token, "DELETE", f"/api/teams/{name}", None, (200, 404))
    if not good:
        error(f"purging {name}: HTTP {status}: {answer.get('message', answer)}")
        return False
    if status == 404:
        info(f"  {name}: no such team")
        return True
    if answer.get("namespaceDeleted"):
        info(f"  {name}: purged, with its namespace")
        summary(f"- Purged `{name}`: its team and namespace.")
    else:
        # The console doesn't delete namespaces unless it's allowed to
        # (its teamNamespaces.purge); the namespace stays, labelled retired.
        info(f"  {name}: purged; its namespace stays, labelled retired, for an operator to delete")
        summary(f"- Purged `{name}`'s team. Its namespace stays, labelled retired (nothing new runs there); "
                f"a cluster administrator deletes it: `kubectl delete namespace {name}`.")
    return True


# What a team's secret-stores/*.yaml may hold (together, one team's
# SecretStores). The console
# applies it (PUT /api/teams/<team>/secret-store) and enforces the same
# rules; this check tells the author on their pull request.
ESO_SERVICE_ACCOUNTS = {"eso-gcp", "eso-azure", "eso-aws"}
CREDENTIAL_SECRET = "eso-auth"
SECRET_STORE_APIS = {"external-secrets.io/v1", "external-secrets.io/v1beta1"}


def _find(node: Any, path: str, wanted: Any) -> list[tuple[str, Any]]:
    """(path, value) for every key under `node` that `wanted(key)` accepts."""
    found: list[tuple[str, Any]] = []
    if isinstance(node, dict):
        for key, value in node.items():
            child = f"{path}.{key}"
            if wanted(key):
                found.append((child, value))
            found += _find(value, child, wanted)
    elif isinstance(node, list):
        for index, value in enumerate(node):
            found += _find(value, f"{path}[{index}]", wanted)
    return found


def secret_store_problems(team: str, documents: list[Any]) -> list[str]:
    problems: list[str] = []
    stores = 0
    for number, doc in enumerate(documents, start=1):
        if doc is None:
            continue
        where = f"document {number}"
        if not isinstance(doc, dict):
            problems.append(f"{where}: isn't a Kubernetes object.")
            continue
        kind, api = doc.get("kind"), doc.get("apiVersion")
        metadata = doc.get("metadata") or {}
        name = metadata.get("name")
        where = f"{kind or '?'} {name or '?'} ({where})"
        if metadata.get("namespace") not in (None, team):
            problems.append(f"{where}: namespace must be {team!r} (or left out), not {metadata.get('namespace')!r}.")
        if kind == "ServiceAccount" and api == "v1":
            if name not in ESO_SERVICE_ACCOUNTS:
                problems.append(f"{where}: the only ServiceAccounts allowed here are the ones ESO signs in as: "
                                f"{', '.join(sorted(ESO_SERVICE_ACCOUNTS))}.")
        elif kind == "SecretStore" and api in SECRET_STORE_APIS:
            stores += 1
            spec = doc.get("spec") or {}
            for ref_path, _ in _find(spec, "spec", lambda k: k == "namespace"):
                problems.append(f"{where}: {ref_path} points into another namespace; leave it out.")
            for ref_path, ref in _find(spec, "spec", lambda k: k.lower().endswith("secretref")):
                if not isinstance(ref, dict) or ref.get("name") != CREDENTIAL_SECRET:
                    problems.append(f"{where}: {ref_path} must name the Secret {CREDENTIAL_SECRET!r} (where the team's "
                                    f"BOOTSTRAP_CREDENTIAL is stored), not {ref.get('name') if isinstance(ref, dict) else ref!r}.")
        else:
            problems.append(f"{where}: only SecretStore ({' or '.join(sorted(SECRET_STORE_APIS))}) and "
                            "ServiceAccount (v1) are allowed here.")
    if stores == 0:
        problems.append("No SecretStore in the file.")
    return problems


def _secret_store_folder(team: str) -> Path:
    return ROOT / "teams" / team / "secret-stores"


def _secret_store_files(team: str) -> list[Path]:
    folder = _secret_store_folder(team)
    return sorted(folder.glob("*.yaml")) if folder.is_dir() else []


def secret_store_teams() -> list[str]:
    return [name for name in team_names() if _secret_store_files(name)]


def _secret_store_documents(team: str) -> tuple[list[Any], list[str]]:
    files = _secret_store_files(team)
    if not files:
        return [], [f"no teams/{team}/secret-stores/*.yaml"]
    documents: list[Any] = []
    for path in files:
        try:
            documents += [d for d in yaml.safe_load_all(path.read_text()) if d is not None]
        except yaml.YAMLError as e:
            return [], [f"{path.name}: not valid YAML: {e}"]
    return documents, []


def secret_stores_check(teams: list[str]) -> bool:
    ok = True
    for team in teams:
        path = _secret_store_folder(team)
        documents, problems = _secret_store_documents(team)
        problems = problems or secret_store_problems(team, documents)
        for p in problems:
            error(p, path)
        info(f"  {'FAIL' if problems else 'ok  '} teams/{team}/secret-stores")
        ok = ok and not problems
    return ok


def secret_stores_apply(teams: list[str], settings: Settings, token: str) -> bool:
    credential = os.environ.get("BOOTSTRAP_CREDENTIAL") or None
    if credential and len(teams) != 1:
        raise SystemExit("BOOTSTRAP_CREDENTIAL is one team's: apply one team at a time with it set")
    if not secret_stores_check(teams):
        return False
    ok = True
    for team in teams:
        documents, _ = _secret_store_documents(team)
        body: dict[str, Any] = {"documents": documents}
        if credential:
            body["credential"] = credential
        good, status, answer = _console_call(settings, token, "PUT", f"/api/teams/{team}/secret-store", body, (204,))
        if good:
            info(f"  {team}: applied{' (with its stored credential)' if credential else ''}")
        else:
            problems = answer.get("problems") or [answer.get("message", answer)]
            for p in problems:
                error(f"{team}: HTTP {status}: {p}", _secret_store_folder(team))
            ok = False
    return ok


def _console_settings() -> tuple[Settings, str]:
    settings = Settings.load()
    if not settings.console:
        raise SystemExit("no console: set console in acyclix.yaml or ACYCLIX_CONSOLE_URL")
    try:
        return settings, console_token(settings)
    except RuntimeError as e:
        raise SystemExit(str(e)) from e


def teams_main(args: argparse.Namespace) -> int:
    if args.action == "changed":
        print(json.dumps(teams_changed(args.base)))
        return 0
    if args.action == "apply":
        names = args.teams or teams_changed(args.changed)
        if not names:
            info("No teams to apply.")
            return 0
        settings, token = _console_settings()
        return 0 if teams_apply(names, settings, token) else 1
    if args.action == "retire":
        names = args.teams or teams_removed(args.removed_since)
        if not names:
            info("No teams to retire.")
            return 0
        settings, token = _console_settings()
        return 0 if teams_retire(names, settings, token) else 1
    settings, token = _console_settings()
    return 0 if teams_purge(args.team, settings, token) else 1


def secret_stores_main(args: argparse.Namespace) -> int:
    teams = args.teams or secret_store_teams()
    if args.action == "check":
        return 0 if secret_stores_check(teams) else 1
    settings, token = _console_settings()
    return 0 if secret_stores_apply(teams, settings, token) else 1


# --- Commands ---------------------------------------------------------------


def check(products: list[Product]) -> list[Product]:
    """Validates, builds, tests and scans; returns those that passed all of it.
    Every product is tried, so one failure never hides another's result."""
    teams_ok = all([validate_teams(), validate_codeowners()])
    passed = []
    for product in products:
        with group(product.label):
            if validate_product(product) and build(product) and test(product) and scan(product):
                info(f"PASS {product.label}")
                passed.append(product)
            else:
                info(f"FAIL {product.label}")
    return passed if teams_ok else []


def main() -> int:
    parser = argparse.ArgumentParser(prog="catalogctl", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("validate", "check", "publish"):
        command = commands.add_parser(name)
        command.add_argument("products", nargs="*", metavar="PRODUCT")
        command.add_argument("--changed", metavar="REF", help="the products changed since REF")
    changed = commands.add_parser("changed")
    changed.add_argument("--base", required=True, metavar="REF")

    teams = commands.add_parser("teams").add_subparsers(dest="action", required=True)
    apply_teams = teams.add_parser("apply")
    apply_teams.add_argument("teams", nargs="*", metavar="TEAM")
    apply_teams.add_argument("--changed", metavar="REF", help="the teams changed since REF (default: all)")
    retire = teams.add_parser("retire")
    retire.add_argument("teams", nargs="*", metavar="TEAM")
    retire.add_argument("--removed-since", metavar="REF", help="the teams whose folder was removed since REF")
    teams.add_parser("purge").add_argument("team", metavar="TEAM")
    teams.add_parser("changed").add_argument("--base", required=True, metavar="REF")

    commands.add_parser("bases").add_argument(
        "--update", action="store_true", help="re-pin already pinned bases to what their tag names now")

    stores = commands.add_parser("secret-stores").add_subparsers(dest="action", required=True)
    for name in ("check", "apply"):
        stores.add_parser(name).add_argument("teams", nargs="*", metavar="TEAM")
    args = parser.parse_args()

    if args.command == "bases":
        return bases(args.update)
    if args.command == "teams":
        return teams_main(args)
    if args.command == "secret-stores":
        return secret_stores_main(args)
    if args.command == "changed":
        print(json.dumps(changed_products(args.base, all_products())))
        return 0

    products = select_products(args.products, args.changed)
    if not products:
        info("No products to check.")
        return 0 if all([validate_teams(), validate_codeowners()]) else 1

    if args.command == "validate":
        results = [validate_teams(), validate_codeowners()] + [validate_product(p) for p in products]
        return 0 if all(results) else 1

    settings = Settings.load()
    if args.command == "publish":
        for problem in settings.problems():
            error(problem, ROOT / "acyclix.yaml")
        if settings.problems():
            return 1
        templates = [p.label for p in products if p.is_template]
        if templates and args.products:
            raise SystemExit(f"Templates are checked, never published: {', '.join(templates)}")
        products = [p for p in products if not p.is_template]
        token = console_token(settings)

    passed = check(products)
    if args.command == "publish":
        published = [p for p in passed if publish(p, settings, token)]
        info(f"\nPublished {len(published)} of {len(products)} product(s).")
        return 0 if len(published) == len(products) else 1
    info(f"\n{len(passed)} of {len(products)} product(s) passed.")
    return 0 if len(passed) == len(products) else 1


if __name__ == "__main__":
    sys.exit(main())
