#!/usr/bin/env node
import { resolve } from 'node:path';
import { buildLocal, findProject, installManifest, resolveCompiler } from '../src/toolchain.mjs';

try {
  const args = process.argv.slice(2);
  const command = args.shift();
  const options = {};
  const positional = [];
  while (args.length) {
    const argument = args.shift();
    if (argument === '--project' || argument === '--manifest') {
      if (!args.length) throw new Error(`${argument} requires a path`);
      options[argument.slice(2)] = args.shift();
    } else if (argument === '--release' || argument === '--offline') options[argument.slice(2)] = true;
    else if (argument.startsWith('--')) throw new Error(`Unknown option: ${argument}`);
    else positional.push(argument);
  }
  const project = options.project ? resolve(options.project) : findProject();
  if (command === 'path' && !positional.length && !options.manifest && !options.release && !options.offline) {
    console.log(resolveCompiler(project).binary);
    process.exit(0);
  }
  let binary;
  if (command === 'build' && options.manifest && !positional.length) {
    binary = buildLocal(options.manifest, { project, release: options.release, offline: options.offline });
  } else if (command === 'install' && positional.length === 1 && !options.manifest && !options.release && !options.offline) {
    binary = await installManifest(positional[0], project);
  } else throw new Error('usage: embedts-toolchain build --manifest RUST/Cargo.toml [--release] [--offline] [--project DIR] | install MANIFEST.json_OR_URL [--project DIR] | path [--project DIR]');
  console.log(`Native compiler installed: ${binary}`);
} catch (error) {
  console.error(`embedts-toolchain: ${error.message}`);
  process.exitCode = 1;
}
