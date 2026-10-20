# Modified for game_developing_agent, 2026: local development workflow and runtime integration.
"""Materialize the reusable dodge template without replacing authored game files."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from ..errors import ToolError
from ..evidence import atomic_write_json

TEMPLATE = Path(__file__).parent / "templates" / "dodge"


def template_targets(project: Path) -> list[tuple[Path, Path]]:
    targets = []
    for directory, destination in (
        ("src", "src"),
        ("scripts", "scripts"),
        ("tests", ".playtest/tests"),
    ):
        targets.extend(
            (source, project / destination / source.relative_to(TEMPLATE / directory))
            for source in sorted((TEMPLATE / directory).rglob("*"))
            if source.is_file()
        )
    targets.extend(
        (TEMPLATE / name, project / name)
        for name in (
            "index.html",
            "package.json",
            "package-lock.json",
            "tsconfig.json",
            "vite.config.js",
        )
    )
    return targets


def require_empty_code_project(project: Path) -> None:
    paths = [target for _, target in template_targets(project)]
    paths.extend(
        project / name
        for name in (
            "game-spec.json",
            "assets/asset-manifest.json",
            "package-lock.json",
        )
    )
    for directory in ("src", "scripts", "levels", "dist", "node_modules"):
        root = project / directory
        if root.is_symlink():
            paths.append(root)
        if root.exists():
            paths.extend(
                path for path in root.rglob("*") if path.is_file() or path.is_symlink()
            )
    paths.extend(
        parent
        for path in list(paths)
        for parent in path.parents
        if parent != project and parent.is_relative_to(project) and parent.is_symlink()
    )
    occupied = [path for path in paths if path.exists() or path.is_symlink()]
    if occupied:
        raise ToolError(
            "SCAFFOLD_TARGET_EXISTS",
            "Dodge template requires empty code targets: "
            + ", ".join(
                sorted({str(path.relative_to(project)) for path in occupied})[:10]
            ),
        )


def materialize_dodge_template(
    project: Path, *, run_id: str, generation_source: str
) -> dict:
    require_empty_code_project(project)
    for source, target in template_targets(project):
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    spec = json.loads((TEMPLATE / "default-spec.json").read_text(encoding="utf-8"))
    spec.update(
        project_id=project.name,
        run_id=run_id,
        revisions={"spec_rev": 1, "game_rev": 1, "asset_rev": 1, "level_rev": 1},
        ui={"hp_font_size": 22},
        generation_source=generation_source,
    )
    spec.pop("spec_rev", None)
    spec["level_factory"]["rngVersion"] = "mulberry32-v1"
    atomic_write_json(project / "game-spec.json", spec)
    atomic_write_json(
        project / "assets/asset-manifest.json",
        {
            "schema_version": 2,
            "qualityProfile": "minimal",
            "fileAssetsRequired": False,
            "runtimeSources": ["composition", "procedural"],
            "assets": [],
        },
    )
    return spec
