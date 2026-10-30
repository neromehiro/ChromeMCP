"""Make a clean unpacked-extension folder without Python runtime files."""
from pathlib import Path
import shutil

root = Path(__file__).resolve().parent
output = root / "extension"
required = [root/'upstream/extension-core.js', root/'content-scripts/codex.js',
            root/'content-scripts/foreign-frame-monitor.js', root/'images/cursor-chat.png']
if any(not path.is_file() for path in required):
    raise SystemExit('External extension inputs are missing. Run scripts/import_runtime.py first.')
output.mkdir(exist_ok=True)
for name in ["manifest.json", "background.js", "extension-inventory.js", "upstream-adapter.js", "transport-buffer.js", "popup.html", "popup.js", "popup.css"]:
    shutil.copy2(root / name, output / name)
for name in ['content-scripts','images']:
    shutil.copytree(root/name,output/name,dirs_exist_ok=True)
(output/'upstream').mkdir(exist_ok=True)
shutil.copy2(root/'upstream/extension-core.js',output/'upstream/extension-core.js')
for obsolete in ['browser-actions.js','page-actions.js','sessions.js']:
    (output/obsolete).unlink(missing_ok=True)
print(output)
