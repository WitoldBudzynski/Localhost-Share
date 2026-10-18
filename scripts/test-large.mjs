// Opt-in real 1 GB round trip: generates data incrementally, without a 1 GB RAM buffer.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { createApp } from '../src/server.mjs';
import { MAX_BYTES, TEMP_PREFIX } from '../src/files.mjs';

const directory = await mkdtemp(path.join(os.tmpdir(), 'localhost-share-large-'));
let app;
try {
  app = await createApp({ directory, host: '127.0.0.1', port: 0, https: false, publicDir: path.resolve('public') });
  const base = app.connections[0].url.split('/#')[0];
  const headers = { Authorization: `Bearer ${app.token}` };
  const expected = createHash('sha256');
  async function* bytes(count, hash) {
    const block = Buffer.alloc(1024 * 1024, 0xa5);
    while (count > 0) { const part = block.subarray(0, Math.min(block.length, count)); hash?.update(part); yield part; count -= part.length; }
  }
  console.log('Uploading exactly 1,000,000,000 bytes…');
  const uploaded = await fetch(base + '/api/upload?path=one-gigabyte.bin', { method: 'PUT', headers, body: Readable.from(bytes(MAX_BYTES, expected)), duplex: 'half' });
  assert.equal(uploaded.status, 201); assert.equal((await uploaded.json()).size, MAX_BYTES);
  const downloaded = await fetch(base + '/api/download?path=one-gigabyte.bin', { headers });
  assert.equal(downloaded.headers.get('content-length'), String(MAX_BYTES));
  const actual = createHash('sha256'); let total = 0;
  for await (const chunk of downloaded.body) { actual.update(chunk); total += chunk.length; }
  assert.equal(total, MAX_BYTES); assert.equal(actual.digest('hex'), expected.digest('hex'));
  console.log('Verified 1 GB download and SHA-256. Checking chunked overflow…');
  const oversized = await fetch(base + '/api/upload?path=too-large.bin', { method: 'PUT', headers, body: Readable.from(bytes(MAX_BYTES + 1)), duplex: 'half' });
  assert.equal(oversized.status, 413);
  assert.ok(!(await readdir(directory)).includes('too-large.bin'));
  const temporary = (await readdir(directory)).find(name => name.startsWith(TEMP_PREFIX));
  assert.deepEqual(await readdir(path.join(directory, temporary)), []);
  console.log('PASS: exact 1 GB upload/download, SHA-256, limit + 1 byte, cleanup.');
} finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
