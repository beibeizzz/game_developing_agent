# Modified for game_developing_agent, 2026: local development workflow and runtime integration.
"""Regression coverage for bounded Plan video request/import parameters."""
import shutil
import subprocess

import pytest

from game_developing_agent_mcp.adapters import rmbg2_video, seedance
from game_developing_agent_mcp.config import Config
from game_developing_agent_mcp.errors import ToolError


def test_invalid_plan_parameters_fail_before_tracking_and_http(tmp_path,monkeypatch):
    monkeypatch.setenv('ARK_AGENT_PLAN_API_KEY','fixture-only')
    monkeypatch.setattr(seedance,'_reserve_plan_media',lambda *a,**k:pytest.fail('Invalid parameters must precede admission'))
    with pytest.raises(ToolError,match='4 seconds'):
        seedance.generate_video(Config.from_env(),prompt='flame',output=tmp_path/'clip.mp4',duration=8)
    with pytest.raises(ToolError,match='fixed first-release'):
        seedance.generate_video(Config.from_env(),prompt='flame',output=tmp_path/'clip.mp4',extra_params={'generate_audio':True})


@pytest.mark.skipif(not shutil.which('ffmpeg'),reason='ffmpeg required for actual extraction')
def test_fixed_import_rate_caps_frames_without_changing_source(tmp_path):
    clip=tmp_path/'source.mp4'
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=c=magenta:s=64x64:r=24:d=4',
                    '-c:v','libx264','-pix_fmt','yuv420p',str(clip)],check=True)
    before=clip.read_bytes()
    frames=rmbg2_video._extract_frames(clip,tmp_path/'frames',extract_fps=12,max_frames=24)
    assert len(frames)==24
    assert clip.read_bytes()==before
    assert rmbg2_video._probe_fps(clip)==24
