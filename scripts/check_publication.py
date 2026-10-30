"""Check tracked files only; runtime inputs must never enter the public repository."""
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
files = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
distributed = set(json.loads((ROOT / 'distribution-assets.json').read_text()))
locked = set(json.loads((ROOT / 'vendor-lock.json').read_text())['sha256']) - distributed
forbidden = {'.runtime', '.venv', '.local', 'node_modules', 'extension', 'comparison', 'evidence', 'output', '.playwright-cli'}
issues = []
for name in filter(None, files):
    path = Path(name)
    if name in locked or forbidden.intersection(path.parts) or path.name.startswith('.env'):
        issues.append(f'{name}: excluded file')
    raw = (ROOT / path).read_bytes()
    if name in distributed and path.suffix in {'.png', '.br'}:
        continue
    if b'\0' in raw:
        issues.append(f'{name}: unexpected binary')
        continue
    text = raw.decode('utf-8')
    if name == 'upstream/browser-engine.mjs':
        # Fixed upstream build path, not a user account or local profile.
        text = text.replace('/home/' + 'oai/.config/gaas-browser/config.json', '<upstream-config>')
    # Report paths, never matching secret values.
    for label, pattern in [('personal home path', r'/(?:Users|home)/[a-zA-Z0-9_-]+/'), ('private parent project', r'codex[_-]mobile'), ('GitHub token', r'gh[pousr]_[A-Za-z0-9]{20,}'), ('private key', r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')]:
        if re.search(pattern, text):
            issues.append(f'{name}: {label}')
if issues:
    raise SystemExit('\n'.join(issues))
print(f'Publication boundaries passed ({len([f for f in files if f])} tracked files).')
