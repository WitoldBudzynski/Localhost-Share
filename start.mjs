#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const project = path.dirname(fileURLToPath(import.meta.url));
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error('Wymagany Node.js 24 lub nowszy.');
  process.exit(1);
}
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(`Localhost Share — uruchom: node start.mjs [opcje]
  --dir <katalog>       Udostępniany katalog (domyślnie ./shared)
  --port <numer>        Port HTTP (domyślnie 8080)
  --https-port <numer>  Port HTTPS (domyślnie 8443)
  --host <adres IPv4>   Lokalny adres IP do nasłuchiwania (autowykrywanie)
  --http-only          Uruchom tylko HTTP
  --https-only         Uruchom tylko HTTPS
  --help               Pomoc
Zatrzymanie: Ctrl+C. Przy pierwszym uruchomieniu wymagany internet (npm).`);
  process.exit(0);
}

function command(executable, argv) {
  return new Promise((resolve, reject) => {
    // cmd.exe is required for npm.cmd on Windows; arguments here are fixed.
    const child = spawn(executable, argv, { cwd: project, stdio: 'inherit', shell: process.platform === 'win32' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${executable}: ${signal || code}`)));
  });
}

try {
  const lock = await readFile(path.join(project, 'package-lock.json'));
  const hash = createHash('sha256').update(lock).update(process.platform).update(process.arch).digest('hex');
  const stamp = path.join(project, 'node_modules', '.localhost-share-lock');
  let installed = '';
  try { installed = await readFile(stamp, 'utf8'); } catch { /* First run. */ }
  if (installed !== hash) {
    await command(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--include=dev', '--no-fund', '--no-audit']);
    await writeFile(stamp, hash);
  }
  await import('./scripts/build.mjs');
  const { run } = await import('./dist/server.mjs');
  await run(args);
} catch (error) {
  console.error(`Nie udało się uruchomić aplikacji: ${error.message}`);
  process.exitCode = 1;
}
