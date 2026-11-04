#!/usr/bin/env python3
"""Install packaged tools into a temporary project and compile with an empty PATH."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile


def run(args, cwd, env):
    result = subprocess.run(list(map(str, args)), cwd=cwd, env=env, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(f'{args[0]} failed ({result.returncode}):\n{result.stdout}{result.stderr}')
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--distribution', type=Path, required=True)
    parser.add_argument('--packages', type=Path, required=True)
    parser.add_argument('--receipt', type=Path)
    args = parser.parse_args()
    manifests = list(args.distribution.resolve().glob('*.json'))
    if len(manifests) != 1:
        raise ValueError('distribution must contain exactly one toolchain manifest')
    package_root = args.packages.resolve()
    packages = []
    for pattern in ('embedts-builder-*.tgz', 'dango-sdk-*.tgz'):
        found = list(package_root.glob(pattern))
        if len(found) != 1:
            raise ValueError(f'expected exactly one {pattern} package')
        packages.extend(found)
    env = dict(os.environ)
    for key in ('EMBEDTS_BIN', 'EMBEDTS_TEST_COMPILER'):
        env.pop(key, None)
    with tempfile.TemporaryDirectory(prefix='embedts-distribution-') as temporary:
        root = Path(temporary)
        project = root / 'project with spaces'
        project.mkdir()
        (project / 'package.json').write_text('{"name":"detached-consumer","private":true,"type":"module"}')
        run(['npm', 'install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', *packages], project, env)
        node = run(['node', '-p', 'process.execPath'], project, env).strip()
        toolchain = project / 'node_modules/@embedts/builder/bin/toolchain.mjs'
        launcher = project / 'node_modules/@embedts/builder/bin/embedts.mjs'
        run([node, toolchain, 'install', manifests[0]], project, env)
        (project / 'embedts.workspace.json').write_text('{"sdk":"node_modules/@dango/sdk"}')
        (project / 'launcher.json').write_text('{"id":"distribution-check","entry":"main.ts"}')
        (project / 'main.ts').write_text('import {nowMs} from "@dango/sdk/system";import {Random} from "@dango/sdk/game";export function main():number{return nowMs()+new Random(1).next();}')
        native = run([node, toolchain, 'path'], project, env).strip()
        empty_path = {**env, 'PATH': ''}
        wrapped_output, native_output = root / 'wrapped', root / 'native'
        run([node, launcher, 'app', '.', '--out', wrapped_output], project, empty_path)
        run([native, 'app', '.', '--out', native_output], project, empty_path)
        report = json.loads((native_output / 'build-report.json').read_text())
        wrapper_report = json.loads((wrapped_output / 'build-report.json').read_text())
        assert report['toolchain'] == wrapper_report['toolchain']
        identity = json.loads(run([native, '--version'], project, empty_path))
        assert report['toolchain'] == identity
        sdk = json.loads((project / 'node_modules/@dango/sdk/package.json').read_text())
        assert report['sdk']['version'] == sdk['version']
        payload = native_output / 'distribution-check/main.etb'
        data = payload.read_bytes()
        assert data == (wrapped_output / 'distribution-check/main.etb').read_bytes()
        assert data[:8] == b'EMBEDTS\0'
        assert data[16:48].hex() == identity['bytecode']['engine_id']
        assert struct.unpack_from('<I', data, 48)[0] == identity['bytecode']['host_abi']
        assert hashlib.sha256(data[84:]).digest() == data[52:84]
        for excluded in ('package.json', 'package-lock.json', 'embedts.workspace.json', 'embedts-toolchain.json', '.embedts', 'node_modules', 'main.ts'):
            assert not (native_output / 'distribution-check' / excluded).exists(), excluded
        receipt = {'status': 'passed', 'toolchain': identity, 'sdk': report['sdk'],
                   'platform': json.loads(manifests[0].read_text())['platform'],
                   'arch': json.loads(manifests[0].read_text())['arch'],
                   'package_sha256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in packages},
                   'payload_sha256': hashlib.sha256(data).hexdigest(),
                   'wrapper_and_native_match': True, 'native_environment': {'PATH': ''},
                   'device_executed': False}
    text = json.dumps(receipt, indent=2) + '\n'
    if args.receipt:
        args.receipt.parent.mkdir(parents=True, exist_ok=True)
        args.receipt.write_text(text)
    print(text, end='')


if __name__ == '__main__':
    main()
