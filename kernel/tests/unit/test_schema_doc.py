# SPDX-License-Identifier: MIT
"""The console's database guide documents the kernel's tables too
(console/docs/06-database-schemas.md). This keeps that half in step with
the models: a table or column added, renamed or dropped here fails until
the guide says so."""

import re
from pathlib import Path

from app.persistence import models  # noqa: F401  (registers every table on Base.metadata)
from app.persistence.database import Base

GUIDE = Path(__file__).resolve().parents[3] / "console" / "docs" / "06-database-schemas.md"


def documented_columns(markdown: str) -> dict[str, set[str]]:
    """The backticked names in the first cell of each "### <table>" section's rows."""
    tables: dict[str, set[str]] = {}
    current: set[str] | None = None
    for line in markdown.splitlines():
        heading = re.match(r"^#{2,3} (.+)$", line)
        if heading:
            name = heading.group(1)
            current = tables.setdefault(name, set()) if re.fullmatch(r"[a-z_]+", name) else None
            continue
        first_cell = re.match(r"^\| (`[^|]+) \|", line)
        if current is not None and first_cell:
            current.update(re.findall(r"`([a-z_]+)`", first_cell.group(1)))
    return tables


def test_guide_documents_every_kernel_table_and_column() -> None:
    text = GUIDE.read_text()
    kernel_half = text[text.index("## The kernel database") : text.index("## The console database")]
    documented = documented_columns(kernel_half)
    actual = {
        table.name: {column.name for column in table.columns}
        for table in Base.metadata.sorted_tables
    }
    assert sorted(documented) == sorted(actual)
    for table, columns in actual.items():
        assert documented[table] == columns, table
