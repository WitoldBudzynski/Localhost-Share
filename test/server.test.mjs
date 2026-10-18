import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { createApp } from '../src/server.mjs';
import { MAX_BYTES, segments, TEMP_PREFIX } from '../src/files.mjs';
import { allowPeer, isPrivateIPv4 } from '../src/network.mjs';

let sandbox, app, base, auth;
before(async () => {
  sandbox = await mkdtemp(path.join(os.tmpdir(), 'localhost-share-test-'));
  app = await createApp({ directory: path.join(sandbox, 'shared'), host: '127.0.0.1', port: 0, httpsPort: 0, certDirectory: path.join(sandbox, 'cert'), publicDir: path.resolve('public') });
  base = app.connections[0].url.split('/#')[0];
  auth = { Authorization: `Bearer ${app.token}` };
});
after(async () => { await app?.close(); await rm(sandbox, { recursive: true, force: true }); });
const request = (url, options = {}) => fetch(base + url, { ...options, headers: { ...auth, ...options.headers } });

test('public UI, authentication, session cookie and QR', async () => {
  const page = await fetch(base); assert.equal(page.status, 200); assert.match(await page.text(), /Twoje pliki/);
  assert.equal((await fetch(base + '/api/files')).status, 401);
  assert.equal((await request('/api/files', { headers: { Authorization: 'Bearer ' + 'é'.repeat(48) } })).status, 401);
  const session = await request('/api/session', { method: 'POST' });
  assert.match(session.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const cookie = session.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base + '/api/info', { headers: { Cookie: cookie } })).status, 200);
  const qr = await request('/api/qr'); assert.match(await qr.text(), /<svg/);
});

test('arbitrary binary upload, Unicode paths, folders and exact download', async () => {
  const content = Buffer.from([0, 255, 1, 0, 128, 9, 10]);
  const name = 'zdjęcia/Podróż 2026/dane.unknown';
  const upload = await request('/api/upload?path=' + encodeURIComponent(name), { method: 'PUT', body: content });
  assert.equal(upload.status, 201); assert.equal((await upload.json()).path, name);
  const listing = await request('/api/files?path=' + encodeURIComponent('zdjęcia/Podróż 2026'));
  assert.equal((await listing.json()).entries[0].name, 'dane.unknown');
  const download = await request('/api/download?path=' + encodeURIComponent(name));
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.match(download.headers.get('content-disposition'), /attachment/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), content);
});

test('concurrent uploads never overwrite an existing file', async () => {
  const responses = await Promise.all(['first', 'second', 'third'].map(body => request('/api/upload?path=collision.txt', { method: 'PUT', body })));
  const names = await Promise.all(responses.map(async response => { assert.equal(response.status, 201); return (await response.json()).path; }));
  assert.equal(new Set(names).size, 3);
  const contents = await Promise.all(names.map(name => readFile(path.join(app.root, name), 'utf8')));
  assert.deepEqual(contents.sort(), ['first', 'second', 'third']);
});

test('empty files, active HTML downloads, Range and HEAD', async () => {
  assert.equal((await request('/api/upload?path=empty.bin', { method: 'PUT', body: '' })).status, 201);
  const empty = await request('/api/download?path=empty.bin'); assert.equal((await empty.arrayBuffer()).byteLength, 0);
  await request('/api/upload?path=page.html', { method: 'PUT', body: '<script>alert(1)</script>' });
  const html = await request('/api/download?path=page.html'); assert.equal(html.headers.get('content-type'), 'application/octet-stream'); assert.match(html.headers.get('content-security-policy'), /object-src 'none'/); await html.arrayBuffer();
  await request('/api/upload?path=range.dat', { method: 'PUT', body: '0123456789' });
  const range = await request('/api/download?path=range.dat', { headers: { Range: 'bytes=2-5' } });
  assert.equal(range.status, 206); assert.equal(range.headers.get('content-range'), 'bytes 2-5/10'); assert.equal(await range.text(), '2345');
  assert.equal(await (await request('/api/download?path=range.dat', { headers: { Range: 'bytes=-3' } })).text(), '789');
  const head = await request('/api/download?path=range.dat', { method: 'HEAD' }); assert.equal(head.headers.get('content-length'), '10'); assert.equal(await head.text(), '');
  assert.equal((await request('/api/download?path=range.dat', { headers: { Range: 'bytes=20-' } })).status, 416);
  assert.equal((await request('/api/download?path=empty.bin', { headers: { Range: 'bytes=0-' } })).status, 416);
});

test('traversal, reserved names, symlinks, Origin and Host protection', async t => {
  for (const candidate of ['../outside.txt', '/etc/passwd', 'a/../../b', 'a\\b', 'CON.txt', 'a:b.txt', 'a//b', TEMP_PREFIX + 'x/a', '.localhost-share/key.pem', '.LOCALHOST-SHARE/key.pem', 'dot.']) {
    assert.throws(() => segments(candidate));
    assert.equal((await request('/api/upload?path=' + encodeURIComponent(candidate), { method: 'PUT', body: 'no' })).status, 400);
  }
  assert.equal((await request('/api/info', { headers: { Origin: 'https://evil.invalid' } })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    const req = http.get(base + '/api/info', { headers: { ...auth, Host: 'evil.invalid' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject);
  });
  assert.equal(hostStatus, 403);
  assert.equal((await request('/api/info', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  await mkdir(path.join(sandbox, 'outside')); await writeFile(path.join(sandbox, 'outside/secret.txt'), 'private');
  try { await symlink(path.join(sandbox, 'outside'), path.join(app.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { if (e.code === 'EPERM') { t.diagnostic('Symlink creation unavailable on this host.'); return; } throw e; }
  assert.equal((await request('/api/download?path=linked/secret.txt')).status, 403);
  assert.equal((await request('/api/upload?path=linked/new.txt', { method: 'PUT', body: 'no' })).status, 403);
  const files = (await (await request('/api/files')).json()).entries; assert.ok(!files.some(file => file.name === 'linked' || file.name.startsWith(TEMP_PREFIX)));
});

test('1 GB guard rejects declared oversized uploads and oversized downloads', async () => {
  const status = await new Promise((resolve, reject) => {
    const req = http.request(base + '/api/upload?path=oversize.bin', { method: 'PUT', headers: { ...auth, 'Content-Length': MAX_BYTES + 1 } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.flushHeaders();
  });
  assert.equal(status, 413);
  const { open } = await import('node:fs/promises');
  const handle = await open(path.join(app.root, 'oversized.bin'), 'w'); await handle.truncate(MAX_BYTES + 1); await handle.close();
  assert.equal((await request('/api/download?path=oversized.bin')).status, 413);
  await rm(path.join(app.root, 'oversized.bin'));
});

test('aborted upload leaves no published or temporary file', async () => {
  await new Promise(resolve => {
    const req = http.request(base + '/api/upload?path=aborted.bin', { method: 'PUT', headers: { ...auth, 'Content-Length': 1e7 } });
    req.on('error', () => resolve()); req.write(Buffer.alloc(10000)); setTimeout(() => req.destroy(), 50);
  });
  // Wait for server-side request cleanup, bounded to one second.
  for (let attempt = 0; attempt < 100; attempt++) {
    const temp = (await readdir(app.root)).find(name => name.startsWith(TEMP_PREFIX));
    if (!(await readdir(path.join(app.root, temp))).length) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(!(await readdir(app.root)).includes('aborted.bin'));
  const temp = (await readdir(app.root)).find(name => name.startsWith(TEMP_PREFIX));
  assert.deepEqual(await readdir(path.join(app.root, temp)), []);
});

test('self-signed HTTPS works with SAN, secure session and binary transfer', async () => {
  const tlsBase = app.connections.find(c => c.protocol === 'https').url.split('/#')[0];
  const result = await new Promise((resolve, reject) => {
    const req = https.request(tlsBase + '/api/session', { method: 'POST', rejectUnauthorized: false, headers: auth }, res => {
      const peer = res.socket.getPeerCertificate();
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, cookie: res.headers['set-cookie'][0], peer, data: Buffer.concat(chunks) }));
    }); req.on('error', reject); req.end();
  });
  assert.equal(result.status, 200); assert.match(result.cookie, /; Secure/); assert.match(result.peer.subjectaltname, /IP Address:127.0.0.1/);
  const transfer = await new Promise((resolve, reject) => {
    const req = https.request(tlsBase + '/api/upload?path=tls.bin', { method: 'PUT', rejectUnauthorized: false, headers: { ...auth, 'Content-Length': 3 } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end(Buffer.from([0, 128, 255]));
  });
  assert.equal(transfer, 201); assert.deepEqual(await readFile(path.join(app.root, 'tls.bin')), Buffer.from([0, 128, 255]));
});

test('LAN policy limits peers to selected private subnet and loopback', () => {
  const interfaces = [{ cidr: '192.168.8.10/24' }];
  for (const allowed of ['192.168.8.42', '127.0.0.1', '::1', '::ffff:192.168.8.42']) assert.equal(allowPeer(allowed, interfaces), true, allowed);
  for (const denied of ['8.8.8.8', '192.168.9.1', '10.0.0.1', '2001:db8::1', 'invalid']) assert.equal(allowPeer(denied, interfaces), false, denied);
  assert.equal(isPrivateIPv4('192.168.1.1'), true); assert.equal(isPrivateIPv4('0.0.0.0'), false);
});

test('shutdown closes HTTP/HTTPS listeners and removes staging directory', async () => {
  const urls = app.connections.map(c => c.url.split('/#')[0]);
  await Promise.all([app.close(), app.close()]);
  assert.ok(!(await readdir(app.root)).some(name => name.startsWith(TEMP_PREFIX)));
  for (const url of urls) await new Promise((resolve, reject) => {
    const transport = url.startsWith('https') ? https : http;
    const req = transport.get(url, { rejectUnauthorized: false, agent: false }, res => { res.resume(); reject(new Error('Server still accepts connections')); });
    req.on('error', e => { assert.equal(e.code, 'ECONNREFUSED'); resolve(); });
  });
});
