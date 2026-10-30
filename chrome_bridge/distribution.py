"""Install the bundled unpacked extension without depending on the source checkout."""
from pathlib import Path
import shutil
from .protocol import ROOT

EXTENSION_FILES = (
    'manifest.json', 'background.js', 'extension-inventory.js', 'upstream-adapter.js',
    'transport-buffer.js', 'popup.html', 'popup.js', 'popup.css',
    'content-scripts/codex.js', 'content-scripts/foreign-frame-monitor.js',
    'images/icon128.png', 'images/cursor-chat.png', 'upstream/extension-core.js',
)


def export_extension(destination):
    destination = Path(destination).expanduser().resolve()
    if destination.exists() and any(destination.iterdir()):
        raise ValueError('Choose an empty extension directory; existing files are not overwritten.')
    for name in EXTENSION_FILES:
        if not (ROOT / name).is_file():
            raise RuntimeError(f'Incomplete ChromeMCP installation: {name}')
    destination.mkdir(parents=True, exist_ok=True)
    for name in EXTENSION_FILES:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / name, target)
    return destination
