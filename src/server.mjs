import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual, X509Certificate } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import QRCode from 'qrcode';
import selfsigned from 'selfsigned';
import { allowPeer, isLoopback, localInterfaces } from './network.mjs';
import { HttpError, MAX_BYTES, TEMP_PREFIX, segments, listFiles, openDownload, publishFile } from './files.mjs';

const PUBLIC = fileURLToPath(new URL('./public/', import.meta.url));
const sameSecret = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };

async function certificate(directory, addresses) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const keyFile = path.join(directory, 'key.pem');
  const certFile = path.join(directory, 'cert.pem');
  try {
    const [key, cert] = await Promise.all([readFile(keyFile), readFile(certFile)]);
    const parsed = new X509Certificate(cert);
    if (Date.parse(parsed.validTo) > Date.now() + 86400000 && addresses.every(ip => parsed.checkIP(ip))) return { key, cert };
  } catch { /* Generate on first run, expiry, or network change. */ }
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'Localhost Share' }], {
    keySize: 2048, algorithm: 'sha256',
    notBeforeDate: new Date(Date.now() - 300000), notAfterDate: new Date(Date.now() + 365 * 86400000),
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, ...addresses.map(ip => ({ type: 7, ip }))] }
    ]
  });
  await writeFile(keyFile, pems.private, { mode: 0o600 });
  await writeFile(certFile, pems.cert, { mode: 0o600 });
  return { key: pems.private, cert: pems.cert };
}

export async function createApp(options = {}) {
  await mkdir(options.directory || './shared', { recursive: true });
  const root = await realpath(options.directory || './shared');
  const certDirectory = path.resolve(options.certDirectory || '.localhost-share');
  if (root === certDirectory || root.startsWith(certDirectory + path.sep)) throw new Error('Nie można udostępniać katalogu z kluczem certyfikatu.');
  const token = randomBytes(24).toString('hex');
  const interfaces = options.interfaces || localInterfaces();
  const requested = options.host;
  if (requested && requested !== '127.0.0.1' && !interfaces.some(i => i.address === requested)) {
    throw new Error('--host musi być prywatnym adresem IPv4 lokalnego interfejsu lub 127.0.0.1.');
  }
  // Bind only the chosen LAN interface and loopback, never a public/wildcard address.
  const address = requested || interfaces[0]?.address || '127.0.0.1';
  const selectedInterfaces = interfaces.filter(i => i.address === address);
  const hosts = address === '127.0.0.1' ? [address] : [address, '127.0.0.1'];
  const servers = [];
  const connections = [];
  const active = new Set();
  let uploads = 0;
  let closing = false;
  let closingPromise;
  const assets = new Map();
  const publicDir = options.publicDir || PUBLIC;
  for (const [url, name, mime] of [['/', 'index.html', 'text/html'], ['/app.js', 'app.js', 'text/javascript'], ['/style.css', 'style.css', 'text/css']]) {
    assets.set(url, { data: await readFile(path.join(publicDir, name)), mime });
  }
  const temporary = await mkdtemp(path.join(root, TEMP_PREFIX));

  const authenticated = req => {
    const prefix = req.socket.encrypted ? 'lan_share_https=' : 'lan_share_http=';
    const cookies = (req.headers.cookie || '').split(';').map(c => c.trim());
    return cookies.some(cookie => cookie.startsWith(prefix) && sameSecret(cookie.slice(prefix.length), token)) || sameSecret(req.headers.authorization, `Bearer ${token}`);
  };

  async function upload(req, res, relative) {
    if (!segments(relative).length) throw new HttpError(400, 'Brak nazwy pliku.');
    if (uploads >= 4) throw new HttpError(429, 'Trwają już cztery transfery. Spróbuj ponownie.');
    const length = req.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) throw new HttpError(413, 'Limit jednego pliku wynosi 1 GB.');
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new HttpError(415, 'Wyślij plik bez kompresji transportowej.');
    uploads++;
    const temp = path.join(temporary, randomBytes(16).toString('hex'));
    let handle;
    try {
      handle = await open(temp, 'wx', 0o600);
      let received = 0;
      // FileHandle.writeFile on each chunk writes sequentially and applies disk backpressure.
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        received += chunk.length;
        if (received > MAX_BYTES) throw new HttpError(413, 'Limit jednego pliku wynosi 1 GB.');
        if (closing) throw new HttpError(503, 'Serwer jest zatrzymywany.');
        await handle.writeFile(chunk);
      }
      if (!req.complete || (length !== undefined && received !== Number(length))) throw new HttpError(400, 'Przerwany transfer.');
      await handle.close(); handle = undefined;
      const savedPath = await publishFile(root, relative, temp);
      json(res, 201, { path: savedPath, size: received });
    } finally {
      uploads--;
      await handle?.close();
      await rm(temp, { force: true });
    }
  }

  async function download(req, res, relative) {
    const { handle, stat, name } = await openDownload(root, relative);
    let start = 0, end = stat.size - 1;
    let ranged = false;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || (!match[1] && !match[2]) || stat.size === 0) {
        await handle.close(); res.setHeader('Content-Range', `bytes */${stat.size}`); throw new HttpError(416, 'Nieprawidłowy zakres.');
      }
      if (!match[1]) start = Math.max(0, stat.size - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= stat.size) {
        await handle.close(); res.setHeader('Content-Range', `bytes */${stat.size}`); throw new HttpError(416, 'Zakres poza plikiem.');
      }
      ranged = true;
    }
    const encodedName = encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16)}`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="download"; filename*=UTF-8''${encodedName}`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', Math.max(0, end - start + 1));
    if (ranged) res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.statusCode = ranged ? 206 : 200;
    if (req.method === 'HEAD' || !stat.size) { await handle.close(); res.end(); return; }
    await pipeline(handle.createReadStream({ start, end }), res);
  }

  async function route(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (closing) throw new HttpError(503, 'Serwer jest zatrzymywany.');
    if (!allowPeer(req.socket.remoteAddress, selectedInterfaces)) throw new HttpError(403, 'Dostęp tylko z lokalnej podsieci.');
    const protocol = req.socket.encrypted ? 'https' : 'http';
    const port = req.socket.localPort;
    const allowedHosts = hosts.map(host => `${host}:${port}`).concat(`localhost:${port}`);
    if (!allowedHosts.includes(req.headers.host)) throw new HttpError(403, 'Niedozwolony adres serwera.');
    if (req.headers.origin && req.headers.origin !== `${protocol}://${req.headers.host}`) throw new HttpError(403, 'Niedozwolone źródło żądania.');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Żądanie spoza aplikacji.');
    const url = new URL(req.url, `${protocol}://${req.headers.host}`);
    if (req.method === 'GET' && assets.has(url.pathname)) {
      const asset = assets.get(url.pathname);
      res.writeHead(200, { 'Content-Type': `${asset.mime}; charset=utf-8` }); res.end(asset.data); return;
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
    if (!authenticated(req)) throw new HttpError(401, 'Zeskanuj aktualny kod QR lub podaj kod dostępu z terminala.');
    if (url.pathname === '/api/session' && req.method === 'POST') {
      res.setHeader('Set-Cookie', `lan_share_${protocol}=${token}; HttpOnly; SameSite=Strict; Path=/${protocol === 'https' ? '; Secure' : ''}`);
      json(res, 200, { ok: true }); return;
    }
    if (url.pathname === '/api/info' && req.method === 'GET') {
      json(res, 200, { maxBytes: MAX_BYTES, folder: path.basename(root), connections, local: isLoopback(req.socket.remoteAddress), encrypted: !!req.socket.encrypted }); return;
    }
    if (url.pathname === '/api/qr' && req.method === 'GET') {
      const connection = connections.find(c => c.protocol === url.searchParams.get('protocol')) || connections[0];
      const svg = await QRCode.toString(connection.url, { type: 'svg', margin: 2, width: 256, errorCorrectionLevel: 'M' });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); res.end(svg); return;
    }
    if (url.pathname === '/api/files' && req.method === 'GET') {
      json(res, 200, { entries: await listFiles(root, url.searchParams.get('path') || '') }); return;
    }
    if (url.pathname === '/api/download' && ['GET', 'HEAD'].includes(req.method)) { await download(req, res, url.searchParams.get('path') || ''); return; }
    if (url.pathname === '/api/upload' && req.method === 'PUT') { await upload(req, res, url.searchParams.get('path') || ''); return; }
    if (url.pathname === '/api/stop' && req.method === 'POST') {
      if (!isLoopback(req.socket.remoteAddress)) throw new HttpError(403, 'Zatrzymaj serwer na komputerze.');
      json(res, 200, { ok: true }); setImmediate(() => { void close(); }); return;
    }
    throw new HttpError(404, 'Nie znaleziono zasobu.');
  }

  function handler(req, res) {
    const task = route(req, res).catch(error => {
      if (res.headersSent || res.destroyed) { res.destroy(); return; }
      const status = error.status || (['ENOSPC', 'EDQUOT'].includes(error.code) ? 507 : 500);
      if (status === 500 && !closing) console.error('Błąd żądania:', error.message);
      // Close rejected uploads instead of draining an unbounded request body.
      if (!req.complete) res.setHeader('Connection', 'close');
      json(res, status, { error: error.status ? error.message : status === 507 ? 'Brak miejsca na dysku.' : 'Nie udało się wykonać operacji.' });
    });
    active.add(task); void task.finally(() => active.delete(task));
  }

  async function close() {
    if (closingPromise) return closingPromise;
    closing = true;
    closingPromise = (async () => {
      const stopped = servers.map(server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
      await Promise.all(stopped);
      await Promise.allSettled([...active]);
      await rm(temporary, { recursive: true, force: true });
      options.onClose?.();
    })();
    return closingPromise;
  }

  try {
    const tls = options.https === false ? null : await certificate(certDirectory, hosts);
    for (const [protocol, enabled, requestedPort] of [['http', options.http !== false, options.port ?? 8080], ['https', !!tls, options.httpsPort ?? 8443]]) {
      if (!enabled) continue;
      let port = requestedPort;
      for (const host of hosts) {
        const server = protocol === 'http' ? http.createServer(handler) : https.createServer({ ...tls, minVersion: 'TLSv1.2' }, handler);
        // A 1 GB transfer over a slow Wi-Fi connection may take longer than 5 minutes.
        server.requestTimeout = 0;
        server.headersTimeout = 30000;
        server.setTimeout(120000, socket => socket.destroy());
        servers.push(server);
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.removeListener('error', reject); resolve(); }); });
        port = server.address().port;
        server.on('error', error => console.error('Błąd serwera:', error.message));
      }
      connections.push({ protocol, url: `${protocol}://${address}:${port}/#${token}`, desktop: `${protocol}://127.0.0.1:${port}/#${token}` });
    }
    if (!connections.length) throw new Error('Włącz przynajmniej jeden protokół.');
  } catch (e) { await close(); throw e; }
  return { root, token, address, connections, close };
}

export async function run(args) {
  const { values } = parseArgs({ args, options: { dir: { type: 'string' }, host: { type: 'string' }, port: { type: 'string' }, 'https-port': { type: 'string' }, 'http-only': { type: 'boolean' }, 'https-only': { type: 'boolean' } } });
  if (values['http-only'] && values['https-only']) throw new Error('Wybierz jedną opcję: --http-only albo --https-only.');
  const port = Number(values.port ?? 8080), httpsPort = Number(values['https-port'] ?? 8443);
  if (![port, httpsPort].every(p => Number.isInteger(p) && p >= 1 && p <= 65535)) throw new Error('Port musi być liczbą od 1 do 65535.');
  let shutdown;
  const app = await createApp({ directory: values.dir, host: values.host, port, httpsPort, http: !values['https-only'], https: !values['http-only'], onClose: () => { process.removeListener('SIGINT', shutdown); process.removeListener('SIGTERM', shutdown); process.removeListener('SIGHUP', shutdown); console.log('\nSerwer zatrzymany.'); } });
  console.log(`\nLocalhost Share\nKatalog: ${app.root}\nLimit: 1 GB na plik\nKod dostępu: ${app.token}`);
  if (app.address === '127.0.0.1') console.log(values.host ? 'Wybrano dostęp tylko z tego komputera.' : 'Brak prywatnego interfejsu LAN. Dostęp tylko z tego komputera.');
  for (const connection of app.connections) console.log(`\n${connection.protocol.toUpperCase()}: ${connection.url}\nPanel komputera: ${connection.desktop}`);
  console.log(await QRCode.toString(app.connections[0].url, { type: 'terminal', small: true }));
  console.log('Telefon i komputer muszą być w tej samej sieci. HTTPS: zaakceptuj certyfikat samopodpisany.\nZakończ pracę: Ctrl+C (zatrzymuje oba serwery).');
  shutdown = () => { void app.close().catch(error => { console.error(error.message); process.exitCode = 1; }); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown); process.on('SIGHUP', shutdown);
}
