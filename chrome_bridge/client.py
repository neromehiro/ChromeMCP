import asyncio
import json
import uuid
import os

from websockets.asyncio.client import connect

from .protocol import DEFAULT_PORT, BridgeError

_direct_session = str(uuid.uuid4())
_direct_turn = str(uuid.uuid4())
_owner_id = str(uuid.uuid4())


async def request(method: str, params: dict | None = None, port: int = DEFAULT_PORT):
    try:
        async with connect(f"ws://127.0.0.1:{port}/client", max_size=32 * 1024 * 1024, open_timeout=3) as socket:
            request_id = str(uuid.uuid4())
            await socket.send(json.dumps({"id": request_id, "method": method, "params": params or {}}, ensure_ascii=False))
            response = json.loads(await asyncio.wait_for(socket.recv(), 95))
            if response.get("id") != request_id:
                raise BridgeError("BAD_RESPONSE", "Bridge response ID does not match")
            if "error" in response:
                error = response["error"]
                raise BridgeError(error["code"], error["message"])
            return response["result"]
    except OSError as exc:
        raise BridgeError("BRIDGE_OFFLINE", f"ローカルサーバーが未起動です。chrome-bridge serve を起動してください（port={port}）。") from exc


async def browser_call(action: str, arguments: dict | None = None, browser_id: str | None = None, port: int = DEFAULT_PORT):
    params = {"session_id": _direct_session, "turn_id": _direct_turn, **(arguments or {})}
    return await request("call", {"action": action, "arguments": params, "browser_id": browser_id,
                                  "owner_pid": os.getpid(), "owner_id": _owner_id}, port)


async def require_existing_connection(browser_id: str | None = None, port: int = DEFAULT_PORT):
    """Use an extension already connected to the bridge; never launch Chrome."""
    try:
        status = await request("status", port=port)
    except BridgeError as exc:
        raise RuntimeError("既存のChrome接続を確認できません。対象プロファイルのChromeとローカルブリッジを起動してください。") from exc
    browsers = status.get("browsers", [])
    if browser_id is not None:
        match = next((browser for browser in browsers if browser["id"] == browser_id), None)
        if match is None:
            raise RuntimeError(f"指定されたChrome接続がありません: {browser_id}")
        return match
    if len(browsers) != 1:
        raise RuntimeError(f"接続済みChromeが{len(browsers)}件です。対象プロファイルの拡張を接続し、複数ならbrowser_idを指定してください。")
    return browsers[0]
