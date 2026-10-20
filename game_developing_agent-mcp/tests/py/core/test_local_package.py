# Modified for game_developing_agent, 2026: local development workflow and runtime integration.
from zipfile import ZipFile

from game_developing_agent_mcp.local.cli import package


def test_game_archives_ship_runtime_and_source_without_local_credentials(tmp_path):
    files = {
        'dist/index.html': 'play',
        'dist/assets/player.png': 'pixels',
        'src/scene.js': 'source',
        'assets/generated/thruster.mp4': 'original media',
        'assets/generated/thruster.mp4.task.json': 'signed download url',
        'assets/generated/media-generation-report.json': 'signed download url',
        '.env': 'secret',
        '.env.local': 'secret',
        '.playtest/history/provider.json': 'private history',
        '.playtest/tests/001-core.mjs': 'gameplay verification',
        '.game_developing_agent/usage.json': 'local usage',
        'node_modules/dependency/index.js': 'dependency',
    }
    for name, content in files.items():
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    package(tmp_path)
    with ZipFile(tmp_path / 'delivery/game-source.zip') as archive:
        assert set(archive.namelist()) == {
            'src/scene.js', 'assets/generated/thruster.mp4', '.playtest/tests/001-core.mjs'
        }
    with ZipFile(tmp_path / 'delivery/game-build.zip') as archive:
        assert set(archive.namelist()) == {'index.html', 'assets/player.png', 'START.txt'}
