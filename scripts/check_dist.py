"""Verify release archives contain no development runtimes or local directories."""
from pathlib import Path
import tarfile
import zipfile

blocked = {'.local', '.runtime', '.venv', '.git', 'node_modules', 'comparison', 'evidence'}
for archive in Path('dist').glob('*'):
    if archive.name.endswith('.tar.gz'):
        with tarfile.open(archive) as source:
            names = source.getnames()
    elif archive.suffix in {'.whl', '.zip'}:
        with zipfile.ZipFile(archive) as source:
            names = source.namelist()
            if archive.suffix == '.whl':
                for asset in ('upstream/browser-engine.mjs', 'upstream/browser-accessibility.wasm.br', 'manifest.json'):
                    assert 'chrome_bridge/assets/' + asset in names, asset
    else:
        continue
    unexpected = [name for name in names if blocked.intersection(Path(name).parts)]
    assert not unexpected, f'{archive}: {unexpected}'
    print(f'{archive.name}: package boundaries passed')
