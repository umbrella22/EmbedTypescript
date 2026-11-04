#!/usr/bin/env python3
"""Package one native compiler with its platform, compatibility identity, and checksums."""
import argparse
import hashlib
import json
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
import os


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True, help='new distribution directory')
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    output = args.out.absolute()
    if output.exists():
        raise ValueError(f'output already exists: {output}')
    identity = json.loads(subprocess.check_output([binary, '--version']))
    if identity.get('name') != 'embedts' or identity.get('implementation') != 'rust':
        raise ValueError('expected native embedts compiler identity')
    arch = {'aarch64': 'arm64', 'arm64': 'arm64', 'x86_64': 'x64', 'amd64': 'x64'}.get(platform.machine().lower())
    host = {'darwin': 'darwin', 'linux': 'linux', 'win32': 'win32'}.get(sys.platform)
    if not arch or not host:
        raise ValueError(f'unsupported distribution host: {sys.platform}/{platform.machine()}')
    name = f'embedts-{identity["version"]}-{host}-{arch}'
    filename = name + ('.exe' if host == 'win32' else '')
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=f'.{output.name}-', dir=output.parent))
    try:
        shutil.copy2(binary, stage / filename)
        digest = hashlib.sha256((stage / filename).read_bytes()).hexdigest()
        manifest = {'format': 'embedts-toolchain-v1', 'platform': host, 'arch': arch,
                    'binary': filename, 'sha256': digest, 'identity': identity}
        (stage / f'{name}.json').write_text(json.dumps(manifest, indent=2) + '\n')
        (stage / 'SHA256SUMS').write_text(''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n' for p in sorted(stage.iterdir())))
        os.rename(stage, output)
    except BaseException:
        shutil.rmtree(stage)
        raise
    print(output / f'{name}.json')


if __name__ == '__main__':
    main()
