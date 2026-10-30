"""MCP-owned loopback server; requires no app binary, Node REPL or Unix socket."""
import asyncio
import os
import shutil
import subprocess
from .client import request
from .daemon import Bridge
from .protocol import BridgeError, extension_id

_bridge = None
_server = None
_lock = asyncio.Lock()


def validate_installation():
    node = os.environ.get('CHROME_BRIDGE_NODE') or shutil.which('node')
    if not node:
        raise RuntimeError('ChromeMCP requires Node.js 22+ on PATH (or CHROME_BRIDGE_NODE).')
    version = subprocess.check_output([node, '--version'], text=True).strip()
    if int(version.lstrip('v').split('.')[0]) < 22:
        raise RuntimeError('ChromeMCP requires Node.js 22 or later.')


async def ensure_bridge(port):
    global _bridge, _server
    async with _lock:
        if _server is not None:
            return
        validate_installation()
        bridge = Bridge(port, native=False)
        try:
            server = await bridge.serve()
        except OSError as exc:
            # Another MCP process may own this exact product's loopback bridge.
            # Never send browser commands to an unknown listener on this port.
            try:
                status = await request('status', port=port)
            except Exception:
                raise RuntimeError(f'ChromeMCP port {port} is unavailable.') from exc
            if status.get('product') != 'ChromeMCP' or status.get('extension_id') != extension_id():
                raise RuntimeError(f'Port {port} belongs to a different bridge.') from exc
        else:
            _bridge, _server = bridge, server


async def stop_bridge():
    global _bridge, _server
    if _bridge:
        await _bridge.close()
        _server.close()
        await _server.wait_closed()
        _bridge = _server = None
