import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const packageInfo = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const version = packageInfo.version;
const configName = 'embedts-toolchain.json';
const binaryName = process.platform === 'win32' ? 'embedts.exe' : 'embedts';
const stateFile = project => join(project, '.embedts', 'active.json');
const sha256 = data => createHash('sha256').update(data).digest('hex');

export function findProject(start = process.cwd()) {
  let directory = resolve(start);
  for (;;) {
    if (existsSync(join(directory, configName))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return resolve(start);
    directory = parent;
  }
}

function readConfig(project) {
  const path = join(project, configName);
  if (!existsSync(path)) return undefined;
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof config.version !== 'string' || !/^[0-9a-f]{64}$/.test(config.engine_id ?? '') || !Number.isSafeInteger(config.host_abi) || config.host_abi < 0) {
    throw new Error(`${path}: expected version, engine_id (SHA-256 hex), and host_abi`);
  }
  return config;
}

export function verifyIdentity(identity, config) {
  if (identity?.name !== 'embedts' || identity.implementation !== 'rust' || identity.version !== version ||
      !/^[0-9a-f]{64}$/.test(identity.bytecode?.engine_id ?? '') || !Number.isSafeInteger(identity.bytecode?.host_abi)) {
    throw new Error(`Expected native embedts ${version}; received an incompatible compiler identity`);
  }
  if (config && (identity.version !== config.version || identity.bytecode.engine_id !== config.engine_id || identity.bytecode.host_abi !== config.host_abi)) {
    throw new Error('Compiler version, engine_id, or host_abi differs from embedts-toolchain.json');
  }
  return identity;
}

function inspect(binary, config) {
  let identity;
  try {
    identity = JSON.parse(execFileSync(binary, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (error) {
    throw new Error(`Cannot read native compiler identity from ${binary}: ${error.message}`);
  }
  return verifyIdentity(identity, config);
}

function binaryPath(project, digest) {
  if (!/^[0-9a-f]{64}$/.test(digest ?? '')) throw new Error('Invalid installed compiler checksum');
  return join(project, '.embedts', 'bin', digest, binaryName);
}

export function resolveCompiler(project = findProject(), explicit = process.env.EMBEDTS_BIN) {
  const config = readConfig(project);
  if (explicit) {
    const binary = resolve(explicit);
    return { binary, identity: inspect(binary, config) };
  }
  if (!existsSync(stateFile(project))) {
    throw new Error('No native compiler installed. Run pnpm toolchain:build, use embedts-toolchain install MANIFEST.json, or set EMBEDTS_BIN to a matching executable.');
  }
  const state = JSON.parse(readFileSync(stateFile(project), 'utf8'));
  if (state.platform !== process.platform || state.arch !== process.arch) throw new Error('Installed compiler targets another platform; install a matching distribution');
  const binary = binaryPath(project, state.sha256);
  if (sha256(readFileSync(binary)) !== state.sha256) throw new Error('Installed compiler checksum mismatch; reinstall the toolchain');
  const identity = inspect(binary, config);
  if (!isDeepStrictEqual(identity, state.identity)) throw new Error('Installed compiler identity differs from its installation record');
  return { binary, identity };
}

function installBytes(bytes, manifest, project) {
  if (manifest.format !== 'embedts-toolchain-v1' || manifest.platform !== process.platform || manifest.arch !== process.arch) {
    throw new Error(`Distribution must target ${process.platform}-${process.arch} with format embedts-toolchain-v1`);
  }
  if (sha256(bytes) !== manifest.sha256) throw new Error('Distribution checksum mismatch');
  const config = readConfig(project);
  verifyIdentity(manifest.identity, config);
  mkdirSync(join(project, '.embedts'), { recursive: true });
  const stage = mkdtempSync(join(project, '.embedts', 'install-'));
  try {
    const stagedBinary = join(stage, binaryName);
    writeFileSync(stagedBinary, bytes, { mode: 0o755 });
    chmodSync(stagedBinary, 0o755);
    const identity = inspect(stagedBinary, config);
    if (!isDeepStrictEqual(identity, manifest.identity)) throw new Error('Distribution compiler identity differs from its manifest');
    const destination = binaryPath(project, manifest.sha256);
    mkdirSync(dirname(destination), { recursive: true });
    // A failed installation leaves the active record and previous binary available.
    renameSync(stagedBinary, destination);
    if (!config) {
      writeFileSync(join(project, configName), JSON.stringify({ version: identity.version, engine_id: identity.bytecode.engine_id, host_abi: identity.bytecode.host_abi }, null, 2) + '\n', { flag: 'wx' });
    }
    writeFileSync(join(stage, 'active.json'), JSON.stringify({ ...manifest, binary: undefined }, null, 2) + '\n');
    renameSync(join(stage, 'active.json'), stateFile(project));
    return destination;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

async function readSource(location) {
  if (/^https?:\/\//.test(location)) {
    const response = await fetch(location);
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} for ${location}`);
    return Buffer.from(await response.arrayBuffer());
  }
  return readFileSync(location);
}

export async function installManifest(location, project = findProject()) {
  const manifest = JSON.parse((await readSource(location)).toString('utf8'));
  if (typeof manifest.binary !== 'string' || !manifest.binary || basename(manifest.binary) !== manifest.binary || manifest.binary.includes('\\')) {
    throw new Error('Distribution binary must be a filename beside its manifest');
  }
  // Validate the platform and identity before downloading a native executable.
  if (manifest.format !== 'embedts-toolchain-v1' || manifest.platform !== process.platform || manifest.arch !== process.arch) {
    throw new Error(`Distribution must target ${process.platform}-${process.arch} with format embedts-toolchain-v1`);
  }
  verifyIdentity(manifest.identity, readConfig(project));
  const source = /^https?:\/\//.test(location) ? new URL(manifest.binary, location).href : join(dirname(resolve(location)), manifest.binary);
  return installBytes(await readSource(source), manifest, project);
}

export function buildLocal(manifestPath, { project = findProject(), release = false, offline = false } = {}) {
  const manifest = resolve(manifestPath);
  const cwd = dirname(manifest);
  const toolchain = readFileSync(join(cwd, 'rust-toolchain.toml'), 'utf8').match(/^channel\s*=\s*"([^"]+)"/m)?.[1];
  if (!toolchain) throw new Error('Rust workspace requires a pinned rust-toolchain.toml channel');
  const common = [`+${toolchain}`, '--manifest-path', manifest];
  // Cargo takes the toolchain selector before its command and options after it.
  const cargo = (command, args) => [common[0], command, ...common.slice(1), ...args];
  execFileSync('cargo', cargo('build', ['-p', 'embedts-builder', '--locked', ...(release ? ['--release'] : []), ...(offline ? ['--offline'] : [])]), { cwd, stdio: 'inherit' });
  const metadata = JSON.parse(execFileSync('cargo', cargo('metadata', ['--format-version=1', '--no-deps', '--locked', '--offline']), { cwd, encoding: 'utf8' }));
  const binary = join(metadata.target_directory, release ? 'release' : 'debug', binaryName);
  const bytes = readFileSync(binary);
  const identity = inspect(binary, readConfig(project));
  return installBytes(bytes, { format: 'embedts-toolchain-v1', platform: process.platform, arch: process.arch, sha256: sha256(bytes), identity }, project);
}
