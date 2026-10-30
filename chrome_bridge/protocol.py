from pathlib import Path
import base64
import hashlib
import json

PACKAGE = Path(__file__).resolve().parent
ROOT = PACKAGE / "assets" if (PACKAGE / "assets").is_dir() else PACKAGE.parent
DEFAULT_PORT = 8768
ACTIONS = frozenset({
    "tabs_list", "tab_open", "tab_navigate", "tab_focus", "tab_close",
    "tab_reload", "tab_back", "tab_forward", "google_search",
    "page_snapshot", "page_click", "page_fill", "page_scroll",
    "page_wait_for", "screenshot",
    "session_name", "session_list", "session_tabs", "session_end_turn", "tab_claim", "tab_mark",
    "groups_list", "group_create", "group_update", "tabs_ungroup",
    "page_key", "page_type", "page_drag", "page_select", "page_check", "page_secondary",
    "page_ax_state",
    "page_ax_action", "windows_list",
    "browser_command", "runtime_setup", "runtime_after_code",
})


def extension_id() -> str:
    key = json.loads((ROOT / "manifest.json").read_text())["key"]
    digest = hashlib.sha256(base64.b64decode(key)).digest()[:16].hex()
    return "".join(chr(ord("a") + int(char, 16)) for char in digest)


class BridgeError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code

    def as_dict(self):
        return {"code": self.code, "message": str(self)}
