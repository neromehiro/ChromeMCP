"""Import pinned external files from a locally prepared bridge; never download them."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def import_runtime(source, node):
    source = source.expanduser().resolve()
    lock = json.loads((ROOT / 'vendor-lock.json').read_text())['sha256']
    # Validate the whole set before writing anything. Never copy directories,
    # browser profiles, policy files, credentials, logs, or other runtime files.
    for relative, expected in lock.items():
        path = source / relative
        if not path.is_file():
            raise ValueError(f'Missing external input: {relative}')
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError(f'Unsupported external input: {relative}; pinned hashes must match')
    node = Path(node).expanduser().resolve()
    major = int(subprocess.check_output([str(node), '--version'], text=True).strip().lstrip('v').split('.')[0])
    if major < 22:
        raise ValueError('Node.js 22 or later is required')
    if source == ROOT:
        raise ValueError('Choose a different source directory')
    for relative in lock:
        target = ROOT / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / relative, target)
    (ROOT / '.runtime/node_repl').chmod(0o755)
    target = ROOT / '.runtime/node'
    if target.exists() or target.is_symlink():
        if not target.is_symlink():
            raise ValueError('Refusing to overwrite an existing Node executable')
        target.unlink()
    target.symlink_to(node)
    subprocess.run([sys.executable, str(ROOT / 'build_extension.py')], check=True)
    print('Pinned runtime imported locally. All imported files are Git-ignored.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--from-bridge', type=Path, required=True, help='Prepared Local Chrome Bridge 0.5.3 directory')
    parser.add_argument('--node', required=True, help='Absolute path to a compatible Node.js 22+ executable')
    args = parser.parse_args()
    try:
        import_runtime(args.from_bridge, args.node)
    except (ValueError, OSError, subprocess.CalledProcessError) as exc:
        parser.exit(1, f'{exc}\n')
