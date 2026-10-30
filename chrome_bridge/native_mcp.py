"""Launch the original persistent Node REPL MCP with a local RPC transport."""
import hashlib
import json
import os
from pathlib import Path
import shutil

from .protocol import ROOT

BUNDLED_CODEX=Path('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex')


def codex_cli():
    """Locate the codex CLI the original service starts for config reads.

    The privileged config read (config/read, configRequirements/read) starts a
    codex app-server. Without CODEX_CLI_PATH the runtime falls back to `codex`
    on PATH, which the bridge environment does not provide, so every origin
    check fails closed as "admin-enforced policy could not be verified".
    """
    configured=os.environ.get('CODEX_CLI_PATH','').strip()
    if configured and Path(configured).is_file():
        return configured
    if BUNDLED_CODEX.is_file():
        return str(BUNDLED_CODEX)
    return shutil.which('codex')


def run(port, *, config_source='codex', policy_file=None):
    local=ROOT/'.runtime/node_repl'
    required = [local, ROOT/'.runtime/node', ROOT/'upstream/browser-service.local.mjs',
                ROOT/'upstream/browser-client.mjs', ROOT/'upstream/browser-accessibility.wasm.br']
    if any(not path.is_file() for path in required):
        raise RuntimeError('External runtime is not installed. See README.md and scripts/import_runtime.py.')
    env=os.environ.copy()
    env.update({
        'NODE_REPL_NODE_PATH':str(ROOT/'.runtime/node'),
        'NODE_REPL_TRUSTED_RPC_ENABLED':'1',
        'NODE_REPL_TRUSTED_CODE_PATHS':str(ROOT),
        'NODE_REPL_DISABLE_ANALYTICS':'1',
        'CHROME_BRIDGE_PORT':str(port),
    })
    from .native_transport import native_directory
    # Discovery, operations, settings and turn cleanup belong to the original
    # service. The standard MCP never enters the legacy LocalHost/engine-worker.
    env.pop('BROWSER_USE_BACKEND_PATHS',None)
    env.update({
        'NODE_REPL_TRUSTED_SERVICES':json.dumps({'browser':str(ROOT/'upstream/browser-service.local.mjs')}),
        'BROWSER_USE_BACKEND_DIRECTORY':str(native_directory(port)),
        'BROWSER_USE_DISABLE_AMBIENT_NETWORK':'1','BROWSER_USE_TINYSKY_ENABLED':'1',
        'BROWSER_USE_ACCESSIBILITY_CORE_WASM_PATH':str(ROOT/'upstream/browser-accessibility.wasm.br'),
    })
    if config_source == 'local':
        env['LOCAL_CHROME_POLICY_PATH']=str(Path(policy_file or ROOT/'.runtime/local-browser-policy.json').expanduser().resolve())
        env['CODEX_HOME']=env['LOCAL_CHROME_POLICY_PATH']+'.home'
        Path(env['CODEX_HOME']).mkdir(parents=True, exist_ok=True, mode=0o700)
    elif config_source == 'codex':
        env.pop('LOCAL_CHROME_POLICY_PATH',None)
    else:
        raise ValueError('Unknown browser configuration source')
    # The original CLI also launches the trusted worker's OS sandbox. Local
    # config mode removes account/config-server coupling, not this isolation.
    if codex:=codex_cli():
        env['CODEX_CLI_PATH']=codex
    # Keep the original MCP protocol and result blocks intact. Only host turn
    # boundaries need a transport fallback when js_reset destroys its runtime.
    import asyncio
    from .mcp_transport import relay
    asyncio.run(relay(str(local), env, port))
