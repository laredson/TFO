"""Build local and portable release archives using only the Python standard library."""
from pathlib import Path
import hashlib
import json
import zipfile

root = Path(__file__).resolve().parents[1]
plugin = root / 'plugins/tfo'
manifest = json.loads((plugin / '.codex-plugin/plugin.json').read_text(encoding='utf-8'))
version = manifest['version'].split('+')[0]
if manifest['name'] != 'tfo' or '/' in version or '\\' in version:
    raise ValueError('Unexpected package identity')
dist = root / 'dist'
dist.mkdir(exist_ok=True)
included = ['runtime', 'scripts', 'plugins', 'docs', '.agents']
top_files = ['README.md', 'INSTALL.md', 'MIGRATION_NOTES.md', 'LICENSE.md', 'AGENTS.md', '.gitignore']
excluded = {'docs/RC_VALIDATION.md', 'plugins/tfo/docs/RC_VALIDATION.md'}

def source_files():
    for folder in included:
        for p in sorted((root / folder).rglob('*')):
            if p.is_file() and p.relative_to(root).as_posix() not in excluded and '__pycache__' not in p.parts and p.suffix != '.pyc':
                if p.is_symlink():
                    raise ValueError(f'Linked release file: {p}')
                yield p
    for name in top_files:
        yield root / name

local = dist / f'tfo-{version}-local.zip'
with zipfile.ZipFile(local, 'w', zipfile.ZIP_DEFLATED) as archive:
    for p in source_files():
        archive.write(p, 'tfo/' + p.relative_to(root).as_posix())

portable = dist / f'tfo-{version}-portable.zip'
with zipfile.ZipFile(portable, 'w', zipfile.ZIP_DEFLATED) as archive:
    for p in sorted(plugin.rglob('*')):
        if not p.is_file():
            continue
        relative = p.relative_to(plugin).as_posix()
        if relative == 'plugin.portable.json':
            archive.write(p, 'tfo/plugin.json')
        elif relative not in {'README.md', 'INSTALL.md', 'LICENSE.md', 'docs/RC_VALIDATION.md'} and not relative.startswith('docs/'):
            archive.write(p, 'tfo/' + relative)
    archive.write(root / 'README.md', 'tfo/README.md')
    archive.write(root / 'INSTALL.md', 'tfo/INSTALL.md')
    archive.write(root / 'LICENSE.md', 'tfo/LICENSE.md')
    for p in sorted((root / 'docs').rglob('*')):
        if p.is_file() and p.name != 'RC_VALIDATION.md':
            archive.write(p, 'tfo/' + p.relative_to(root).as_posix())

checksums = []
for p in [local, portable]:
    with zipfile.ZipFile(p) as archive:
        if archive.testzip():
            raise ValueError(f'Archive corruption: {p.name}')
        names = archive.namelist()
        if len(names) != len(set(names)) or any(not name.startswith('tfo/') or '..' in name.split('/') for name in names):
            raise ValueError(f'Invalid archive paths: {p.name}')
    checksums.append(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}')
(dist / 'SHA256SUMS.txt').write_text('\n'.join(checksums) + '\n', encoding='ascii')
print('\n'.join(checksums))
