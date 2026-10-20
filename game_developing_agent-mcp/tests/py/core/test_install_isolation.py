# Modified for game_developing_agent, 2026: local development workflow and runtime integration.
import os
import shutil
import subprocess
from pathlib import Path


def test_launcher_selects_each_checkout_environment(tmp_path):
    script = Path(__file__).parents[4] / "scripts/run.sh"
    for name in ("checkout one", "checkout two"):
        checkout = tmp_path / name
        (checkout / "scripts").mkdir(parents=True)
        (checkout / "game_developing_agent-mcp").mkdir()
        executable = checkout / "game_developing_agent-mcp/.venv/bin/python"
        executable.parent.mkdir(parents=True)
        executable.write_text("#!/bin/sh\nexit 0\n")
        executable.chmod(0o755)
        shutil.copyfile(script, checkout / "scripts/run.sh")
        env = dict(os.environ)
        env.pop("GAME_DEVELOPING_AGENT_PYTHON_ENV", None)
        env["UV_PROJECT_ENVIRONMENT"] = "/obsolete/shared/environment"
        result = subprocess.run(
            ["bash", str(checkout / "scripts/run.sh"), "env"],
            env=env, capture_output=True, text=True, check=True,
        )
        values = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
        assert values["UV_PROJECT_ENVIRONMENT"] == str(checkout / "game_developing_agent-mcp/.venv")
        assert values["GAME_DEVELOPING_AGENT_REPO_ROOT"] == str(checkout)
