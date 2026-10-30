"""Persist browser screenshots without requiring image-capable MCP clients."""

import base64
from datetime import datetime, timezone
import os
from pathlib import Path
import struct
import tempfile


def _jpeg_dimensions(data: bytes) -> tuple[int, int]:
    offset = 2
    while offset + 4 <= len(data):
        if data[offset] != 0xff:
            offset += 1
            continue
        marker = data[offset + 1]
        offset += 2
        if marker in (0xd8, 0xd9, 0x01) or 0xd0 <= marker <= 0xd7:
            continue
        if offset + 2 > len(data):
            break
        length = struct.unpack(">H", data[offset:offset + 2])[0]
        if length < 2 or offset + length > len(data):
            break
        if marker in (*range(0xc0, 0xc4), *range(0xc5, 0xc8), *range(0xc9, 0xcc), *range(0xcd, 0xd0)):
            if length < 7:
                break
            height, width = struct.unpack(">HH", data[offset + 3:offset + 7])
            return width, height
        offset += length
    raise ValueError("Chrome returned JPEG data without dimensions")


def save_capture(encoded: str, tab_id: int, save_path: str | None = None) -> dict:
    data = base64.b64decode(encoded, validate=True)
    if len(data) >= 24 and data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR":
        fmt, extension = "png", ".png"
        width, height = struct.unpack(">II", data[16:24])
    elif data[:3] == b"\xff\xd8\xff":
        fmt, extension = "jpeg", ".jpg"
        width, height = _jpeg_dimensions(data)
    else:
        raise ValueError("Chrome returned an unsupported screenshot format")
    if not width or not height:
        raise ValueError("Chrome returned invalid screenshot dimensions")
    if save_path is None:
        cache = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")).expanduser().resolve()
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        target = cache / "local-chrome-bridge" / "captures" / f"tab-{tab_id}-{stamp}{extension}"
    else:
        target = Path(save_path).expanduser()
        if not target.is_absolute():
            raise ValueError("save_path must be an absolute path")
        if target.suffix.lower() not in {extension, ".jpeg" if fmt == "jpeg" else extension}:
            raise ValueError(f"save_path must end with {extension} for this screenshot")
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".capture-", suffix=extension, dir=target.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            os.fchmod(output.fileno(), 0o600)
            output.write(data)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return {"path": str(target), "tab_id": tab_id, "width": width, "height": height, "bytes": len(data), "format": fmt}
