#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { resolveCompiler } from '../src/toolchain.mjs';

try {
  const { binary } = resolveCompiler();
  const result = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(`embedts: ${error.message}`);
  process.exitCode = 1;
}
