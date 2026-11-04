"""Exercise real SDK inputs and native compiler behavior across workspace boundaries."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SDK = ROOT / 'typescript/packages/sdk'


class Workspaces(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.compiler = Path(os.environ.get('EMBEDTS_TEST_COMPILER', ROOT / 'rust/target/debug/embedts')).resolve()
        if not cls.compiler.is_file():
            raise RuntimeError('Build embedts first or set EMBEDTS_TEST_COMPILER')

    def test_real_sdk_type_only_async_native_and_helpers(self):
        sources = [
            'import type {Point} from "dango:display";export function main():number{const p:Point={id:0,x:1,y:2};return p.x+p.y;}',
            'import {sleep,nowMs} from "dango:system";export async function main():Promise<number>{await sleep(1);return nowMs();}',
            'import {emit} from "dango:host";export function main():number{emit(42);return 42;}',
            'import {Random} from "@dango/sdk/game";import {print} from "@dango/sdk/system";export function main():number{print("workspace");return new Random(1).next();}',
        ]
        with tempfile.TemporaryDirectory(prefix='embedts-sdk-') as temporary:
            root = Path(temporary)
            for index, source in enumerate(sources):
                with self.subTest(index=index):
                    entry = root / f'main{index}.ts'
                    entry.write_text(source)
                    outputs = [root / f'main{index}-{run}.etb' for run in range(2)]
                    for output in outputs:
                        subprocess.run([self.compiler, 'build', entry, '--out', output, '--sdk', SDK], env={**os.environ, 'PATH': ''}, check=True, capture_output=True)
                    self.assertEqual(outputs[0].read_bytes(), outputs[1].read_bytes())

    def test_copied_compiler_and_sdk_build_without_checkout_or_node(self):
        with tempfile.TemporaryDirectory(prefix='embedts-detached-') as temporary:
            root = Path(temporary)
            compiler = root / self.compiler.name
            shutil.copy2(self.compiler, compiler)
            sdk = root / '依赖 SDK'
            shutil.copytree(SDK, sdk, ignore=shutil.ignore_patterns('node_modules'))
            (root / 'main.ts').write_text('import {nowMs} from "@dango/sdk/system";export function main():number{return nowMs();}')
            (root / 'launcher.json').write_text('{"id":"detached","entry":"main.ts"}')
            (root / 'embedts.workspace.json').write_text(json.dumps({'sdk': sdk.name}))
            output = root / 'output'
            result = subprocess.run([compiler, 'app', '.', '--out', output], cwd=root, env={**os.environ, 'PATH': ''}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads((output / 'build-report.json').read_text())
            identity = json.loads(subprocess.check_output([compiler, '--version']))
            self.assertEqual(report['toolchain'], identity)
            self.assertEqual(report['sdk']['version'], json.loads((sdk / 'package.json').read_text())['version'])
            self.assertEqual(report['sdk']['host_abi'], identity['bytecode']['host_abi'])
            self.assertFalse((output / 'detached/embedts.workspace.json').exists())


if __name__ == '__main__':
    unittest.main()
