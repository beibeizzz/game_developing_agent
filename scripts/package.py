"""Create a source release from tracked files, with SHA-256 checksums."""

import argparse
import hashlib
import json
import subprocess
import zipfile
from pathlib import Path


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=root / "dist")
    args = parser.parse_args()
    dirty = subprocess.run(["git", "-C", str(root), "status", "--porcelain"],
                           capture_output=True, text=True, check=True).stdout
    if dirty.strip():
        raise SystemExit("Commit source changes before packaging the release baseline.")
    version = json.loads((root / "RELEASE.json").read_text())["version"]
    tracked = subprocess.run(["git", "-C", str(root), "ls-files", "-z"],
                             capture_output=True, check=True).stdout.decode().split("\0")
    if not any(tracked):
        raise SystemExit("Commit the source baseline before packaging.")
    private_dirs = {".git", ".tools", ".venv", "node_modules", ".game_developing_agent", ".game_developing_agent-local", ".playtest", ".claude-session"}
    pictures = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".mp4", ".webm", ".ico"}
    files = []
    for name in sorted(filter(None, tracked)):
        relative = Path(name)
        if private_dirs.intersection(relative.parts) or relative.suffix.lower() in pictures:
            raise SystemExit(f"Excluded runtime/media file is tracked: {name}")
        if relative.name.startswith(".env") and relative.name != ".env.example":
            raise SystemExit(f"Private environment file is tracked: {name}")
        source = root / relative
        if source.is_symlink() or not source.is_file():
            raise SystemExit(f"Expected regular source file: {name}")
        files.append((relative, source.read_bytes()))
    args.output.mkdir(parents=True, exist_ok=True)
    target = args.output / f"game_developing_agent-{version}-source.zip"
    prefix = f"game_developing_agent-{version}/"
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for relative, data in files:
            entry = zipfile.ZipInfo(prefix + relative.as_posix(), date_time=(2026, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = (0o100755 if relative.suffix == ".sh" or relative.name == "game_developing_agent" else 0o100644) << 16
            archive.writestr(entry, data)
    checksum = hashlib.sha256(target.read_bytes()).hexdigest()
    target.with_suffix(".zip.sha256").write_text(f"{checksum}  {target.name}\n", encoding="utf-8")
    print(json.dumps({"archive": str(target), "files": len(files), "sha256": checksum}))


if __name__ == "__main__":
    main()
