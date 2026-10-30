from pathlib import Path
import os
import shutil
import subprocess

root=Path(__file__).resolve().parent
node=os.environ.get('CHROME_BRIDGE_NODE') or (str(root/'.runtime/node') if (root/'.runtime/node').exists() else shutil.which('node'))
if not node:
    raise SystemExit('Node.js 22+ is required')
raise SystemExit(subprocess.call([node,'--test',*[str(p) for p in sorted((root/'tests').glob('*.test.js'))]],cwd=root))
