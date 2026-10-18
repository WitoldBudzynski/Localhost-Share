import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root, 'dist/public'), { recursive: true });
await build({ absWorkingDir: root, entryPoints: ['src/server.mjs'], outfile: 'dist/server.mjs', bundle: true, packages: 'external', platform: 'node', format: 'esm', target: 'node24', sourcemap: true });
await build({ absWorkingDir: root, entryPoints: ['public/app.js', 'public/style.css'], outdir: 'dist/public', bundle: true, minify: true, target: ['safari16', 'chrome110', 'firefox115'] });
await copyFile(path.join(root, 'public/index.html'), path.join(root, 'dist/public/index.html'));
