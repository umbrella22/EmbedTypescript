import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { findProject, installManifest, resolveCompiler, version } from '../src/toolchain.mjs';

const launcher = fileURLToPath(new URL('../bin/embedts.mjs', import.meta.url));
const identity = { name: 'embedts', implementation: 'rust', version, bytecode: { engine_id: 'a'.repeat(64), host_abi: 3 } };
const temporary = () => mkdtempSync(join(tmpdir(), 'embedts-toolchain-'));

function distribution(root, selectedIdentity = identity) {
  const binary = join(root, 'compiler');
  writeFileSync(binary, `#!${process.execPath}\nif (process.argv[2] === '--version') console.log(${JSON.stringify(JSON.stringify(selectedIdentity))});\nelse {console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}));process.exitCode=Number(process.env.EMBEDTS_TEST_EXIT ?? 0);}\n`);
  chmodSync(binary, 0o755);
  const manifest = { format: 'embedts-toolchain-v1', platform: process.platform, arch: process.arch, binary: 'compiler', sha256: createHash('sha256').update(readFileSync(binary)).digest('hex'), identity: selectedIdentity };
  const file = join(root, 'distribution.json');
  writeFileSync(file, JSON.stringify(manifest));
  return { binary, file, manifest };
}

// Executable script fixtures exercise the process boundary on POSIX hosts.
const posix = { skip: process.platform === 'win32' };

test('installation pins identity and resolves the project from a child directory', posix, async () => {
  const root = temporary();
  try {
    const { file } = distribution(root);
    const binary = await installManifest(file, root);
    assert.equal(resolveCompiler(root, '').binary, binary);
    assert.equal(findProject(join(root, 'examples', 'nested')), root);
    assert.equal(JSON.parse(readFileSync(join(root, 'embedts-toolchain.json'))).engine_id, identity.bytecode.engine_id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a corrupt download leaves the active installation intact', posix, async () => {
  const root = temporary();
  try {
    const { file, binary } = distribution(root);
    await installManifest(file, root);
    const state = readFileSync(join(root, '.embedts', 'active.json'), 'utf8');
    writeFileSync(binary, 'corrupted download');
    await assert.rejects(installManifest(file, root), /checksum mismatch/);
    assert.equal(readFileSync(join(root, '.embedts', 'active.json'), 'utf8'), state);
    assert.deepEqual(resolveCompiler(root, '').identity, identity);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an incompatible compiler version cannot replace the active installation', posix, async () => {
  const root = temporary();
  try {
    const { file } = distribution(root);
    await installManifest(file, root);
    distribution(root, { ...identity, version: '999.0.0' });
    await assert.rejects(installManifest(file, root), /incompatible compiler identity/);
    assert.deepEqual(resolveCompiler(root, '').identity, identity);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('engine and ABI locks reject otherwise matching toolchain versions', posix, async () => {
  const root = temporary();
  try {
    const { file } = distribution(root);
    await installManifest(file, root);
    distribution(root, { ...identity, bytecode: { ...identity.bytecode, host_abi: 4 } });
    await assert.rejects(installManifest(file, root), /differs from embedts-toolchain.json/);
    distribution(root, { ...identity, bytecode: { ...identity.bytecode, engine_id: 'b'.repeat(64) } });
    await assert.rejects(installManifest(file, root), /differs from embedts-toolchain.json/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a manifest for another platform is rejected before reading its executable', posix, async () => {
  const root = temporary();
  try {
    const { file, manifest } = distribution(root);
    writeFileSync(file, JSON.stringify({ ...manifest, platform: 'another-platform', binary: 'missing' }));
    await assert.rejects(installManifest(file, root), /Distribution must target/);
    assert.equal(existsSync(join(root, '.embedts')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an installed executable modified after installation fails verification', posix, async () => {
  const root = temporary();
  try {
    const { file } = distribution(root);
    const binary = await installManifest(file, root);
    writeFileSync(binary, 'changed executable');
    assert.throws(() => resolveCompiler(root, ''), /checksum mismatch/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('launcher preserves arguments, working directory, and compiler exit status', posix, () => {
  const root = temporary();
  try {
    const { binary } = distribution(root);
    const args = ['build', '目录 with spaces/main.ts', '--out', 'output name.etb'];
    const result = spawnSync(process.execPath, [launcher, ...args], { cwd: root, env: { ...process.env, EMBEDTS_BIN: binary, EMBEDTS_TEST_EXIT: '23' }, encoding: 'utf8' });
    assert.equal(result.status, 23, result.stderr);
    const forwarded = JSON.parse(result.stdout);
    assert.deepEqual(forwarded.args, args);
    assert.equal(forwarded.cwd, realpathSync(dirname(binary)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing compiler reports explicit provisioning without invoking Cargo', () => {
  const root = temporary();
  try {
    const result = spawnSync(process.execPath, [launcher, '--version'], { cwd: root, env: { ...process.env, EMBEDTS_BIN: '', PATH: '' }, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No native compiler installed/);
    assert.equal(existsSync(join(root, '.embedts')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('HTTP manifest installation resolves the binary beside the manifest', posix, async () => {
  const root = temporary();
  let server;
  try {
    const { file, binary } = distribution(root);
    server = createServer((request, response) => {
      if (request.url === '/release/distribution.json') response.end(readFileSync(file));
      else if (request.url === '/release/compiler') response.end(readFileSync(binary));
      else { response.statusCode = 404; response.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await installManifest(`http://127.0.0.1:${server.address().port}/release/distribution.json`, root);
    assert.deepEqual(resolveCompiler(root, '').identity, identity);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    rmSync(root, { recursive: true, force: true });
  }
});
