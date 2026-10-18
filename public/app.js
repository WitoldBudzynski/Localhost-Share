const $ = id => document.getElementById(id);
let currentPath = '', entries = [], info, selectedProtocol, qrObjectUrl, currentXHR;
let uploading = false, cancelled = false, noticeTimer;
const icon = name => { const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); const use = document.createElementNS(svg.namespaceURI, 'use'); use.setAttribute('href', `#i-${name}`); svg.append(use); return svg; };
const size = bytes => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : bytes >= 1e3 ? `${(bytes / 1e3).toFixed(1)} kB` : `${bytes} B`;
const joined = (...parts) => parts.filter(Boolean).join('/');
function notice(message) { $('notice').textContent = message; $('notice').hidden = false; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 5500); }
async function api(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) { const body = await response.json().catch(() => ({})); if (response.status === 401) { $('workspace').hidden = true; $('login').hidden = false; } throw new Error(body.error || `Błąd ${response.status}`); }
  return response;
}
async function connect(token) {
  if (token) await api('/api/session', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  info = await (await api('/api/info')).json();
  $('login').hidden = true; $('workspace').hidden = false;
  $('stop-server').hidden = !info.local;
  $('network-label').textContent = info.encrypted ? 'Połączono przez HTTPS' : 'Twoja sieć lokalna';
  selectedProtocol = info.connections.find(c => c.protocol === location.protocol.slice(0, -1))?.protocol || info.connections[0].protocol;
  $('protocol-http').hidden = !info.connections.some(c => c.protocol === 'http');
  $('protocol-https').hidden = !info.connections.some(c => c.protocol === 'https');
  await Promise.all([refresh(), updateConnection()]);
}
async function updateConnection() {
  const connection = info.connections.find(c => c.protocol === selectedProtocol);
  $('connection-address').textContent = connection.url.split('/#')[0];
  $('tls-note').hidden = selectedProtocol !== 'https';
  for (const protocol of ['http', 'https']) $(`protocol-${protocol}`).classList.toggle('selected', protocol === selectedProtocol);
  const response = await api(`/api/qr?protocol=${selectedProtocol}`);
  if (qrObjectUrl) URL.revokeObjectURL(qrObjectUrl);
  qrObjectUrl = URL.createObjectURL(await response.blob()); $('qr-code').src = qrObjectUrl;
}
async function refresh() {
  $('refresh').disabled = true;
  try {
    entries = (await (await api(`/api/files?path=${encodeURIComponent(currentPath)}`)).json()).entries;
    render();
  } finally { $('refresh').disabled = false; }
}
async function navigate(relative) { const previous = currentPath; currentPath = relative; $('search').value = ''; try { await refresh(); } catch (e) { currentPath = previous; notice(e.message); } }
function render() {
  $('breadcrumbs').replaceChildren();
  const crumbs = [{ name: info.folder || 'shared', path: '' }];
  currentPath.split('/').filter(Boolean).forEach((name, index, parts) => crumbs.push({ name, path: parts.slice(0, index + 1).join('/') }));
  crumbs.forEach((crumb, index) => { if (index) $('breadcrumbs').append(document.createTextNode('/')); const button = document.createElement('button'); if (!index) button.append(icon('folder')); button.append(document.createTextNode(crumb.name)); button.onclick = () => navigate(crumb.path); $('breadcrumbs').append(button); });
  const filtered = entries.filter(entry => entry.name.toLocaleLowerCase('pl').includes($('search').value.toLocaleLowerCase('pl')));
  $('file-count').textContent = entries.length;
  $('file-list').replaceChildren();
  for (const entry of filtered) {
    const row = document.createElement('div'); row.className = 'file-row';
    const cell = document.createElement(entry.directory ? 'button' : 'div'); cell.className = `file-info${entry.directory ? ' folder-link' : ''}`;
    if (entry.directory) cell.onclick = () => navigate(joined(currentPath, entry.name));
    const badge = document.createElement('span');
    const ext = entry.name.split('.').pop().toLowerCase();
    badge.className = `file-icon ${entry.directory ? 'folder' : /^(jpg|jpeg|png|heic|gif|webp|svg)$/.test(ext) ? 'image' : /^(mp4|mov|avi|mkv)$/.test(ext) ? 'video' : /^(pdf|docx?|txt|xlsx?)$/.test(ext) ? 'document' : ''}`;
    badge.append(icon(entry.directory ? 'folder' : 'file'));
    const wrap = document.createElement('div'); wrap.className = 'file-name-wrap';
    const title = document.createElement('span'); title.className = 'filename'; title.textContent = entry.name; title.title = entry.name;
    const date = document.createElement('div'); date.className = 'file-date'; date.textContent = `${entry.directory ? 'Folder' : ext === entry.name.toLowerCase() ? 'Plik' : ext.toUpperCase()} · ${new Date(entry.modified).toLocaleDateString('pl-PL')}`;
    wrap.append(title, date); cell.append(badge, wrap);
    const bytes = document.createElement('span'); bytes.className = 'file-size'; bytes.textContent = entry.directory ? '—' : size(entry.size);
    const action = document.createElement(entry.directory ? 'button' : 'a'); action.className = 'icon-button';
    if (entry.directory) { action.append(icon('arrow')); action.style.transform = 'rotate(180deg)'; action.setAttribute('aria-label', `Otwórz folder ${entry.name}`); action.onclick = cell.onclick; }
    else { action.append(icon('download')); action.setAttribute('aria-label', `Pobierz ${entry.name}`); if (entry.downloadable) { action.href = `/api/download?path=${encodeURIComponent(joined(currentPath, entry.name))}`; action.download = entry.name; } else { action.title = 'Plik przekracza limit 1 GB'; action.setAttribute('aria-disabled', 'true'); action.onclick = () => notice('Ten plik przekracza limit 1 GB.'); } }
    row.append(cell, bytes, action); $('file-list').append(row);
  }
  $('empty-state').hidden = filtered.length !== 0;
  $('empty-state').querySelector('p').textContent = entries.length ? 'Nie znaleziono plików' : 'Tu jest miejsce na Twoje pliki';
  $('folder-summary').textContent = `${entries.filter(e => !e.directory).length} plików · ${size(entries.filter(e => !e.directory).reduce((sum, e) => sum + e.size, 0))}`;
}
function transferFile(file, relative, progress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); currentXHR = xhr;
    xhr.open('PUT', `/api/upload?path=${encodeURIComponent(relative)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = event => { if (event.lengthComputable) progress(event.loaded, event.total); };
    xhr.onerror = () => reject(new Error('Przerwane połączenie. Sprawdź sieć i serwer.'));
    xhr.onabort = () => reject(new Error('Anulowano transfer.'));
    xhr.onload = () => { let data; try { data = JSON.parse(xhr.responseText); } catch { data = {}; } if (xhr.status >= 200 && xhr.status < 300) resolve(data); else reject(new Error(data.error || `Błąd ${xhr.status}`)); };
    xhr.send(file);
  });
}
async function uploadFiles(files) {
  if (uploading) { notice('Poczekaj na zakończenie bieżącej kolejki.'); return; }
  if (!files.length) return;
  uploading = true; cancelled = false; const destination = currentPath;
  $('transfers').hidden = false; $('cancel-upload').hidden = false; $('transfer-list').replaceChildren();
  for (const item of files) {
    if (cancelled) break;
    const file = item.file || item; const relative = item.relative || file.webkitRelativePath || file.name;
    const row = document.createElement('div'); row.className = 'transfer';
    const title = document.createElement('div'); title.className = 'transfer-title';
    const name = document.createElement('span'); name.textContent = relative;
    const status = document.createElement('span'); status.textContent = '0%';
    const progress = document.createElement('progress'); progress.max = 100; progress.value = 0;
    title.append(name, status); row.append(title, progress); $('transfer-list').prepend(row);
    // Keep a bounded UI for large folders.
    while ($('transfer-list').children.length > 8) $('transfer-list').lastChild.remove();
    try {
      if (file.size > info.maxBytes) throw new Error('Plik przekracza limit 1 GB.');
      const result = await transferFile(file, joined(destination, relative), (loaded, total) => { progress.value = Math.round(loaded / total * 100); status.textContent = progress.value === 100 ? 'Zapisywanie…' : `${progress.value}%`; });
      progress.value = 100; status.textContent = 'Gotowe'; row.classList.add('done');
      name.title = result.path;
    } catch (e) { row.classList.add('error'); status.textContent = e.message; }
  }
  uploading = false; currentXHR = undefined; $('cancel-upload').hidden = true;
  notice(cancelled ? 'Anulowano kolejkę. Ukończone pliki są zachowane.' : 'Kolejka zakończona. Sprawdź status plików.');
  try { await refresh(); } catch (e) { notice(e.message); }
}
async function walkEntry(entry, prefix = '') {
  if (entry.isFile) { const file = await new Promise((resolve, reject) => entry.file(resolve, reject)); return [{ file, relative: joined(prefix, file.name) }]; }
  const reader = entry.createReader(); const result = [];
  while (true) { const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject)); if (!batch.length) break; for (const child of batch) result.push(...await walkEntry(child, joined(prefix, entry.name))); }
  return result;
}
$('choose-files').onclick = () => $('file-input').click();
$('choose-folder').onclick = () => $('folder-input').click();
for (const id of ['file-input', 'folder-input']) $(id).onchange = event => { const files = Array.from(event.target.files); event.target.value = ''; void uploadFiles(files); };
$('cancel-upload').onclick = () => { cancelled = true; currentXHR?.abort(); };
$('refresh').onclick = () => refresh().catch(e => notice(e.message));
$('search').oninput = render;
for (const protocol of ['http', 'https']) $(`protocol-${protocol}`).onclick = () => { selectedProtocol = protocol; updateConnection().catch(e => notice(e.message)); };
$('copy-link').onclick = async () => {
  const link = info.connections.find(c => c.protocol === selectedProtocol).url;
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(link);
    else { const input = document.createElement('textarea'); input.value = link; input.style.position = 'fixed'; input.style.opacity = '0'; document.body.append(input); input.select(); const copied = document.execCommand('copy'); input.remove(); if (!copied) throw new Error(); }
    notice('Skopiowano link dostępu.');
  } catch { notice('Nie udało się skopiować. Użyj kodu QR.'); }
};
$('login-form').onsubmit = async event => { event.preventDefault(); $('login-error').textContent = ''; try { await connect($('access-code').value.trim()); $('access-code').value = ''; } catch (e) { $('login-error').textContent = e.message; } };
$('stop-server').onclick = async () => { try { await api('/api/stop', { method: 'POST' }); $('workspace').hidden = true; notice('Udostępnianie zakończone. Serwery HTTP i HTTPS zostały zatrzymane.'); } catch (e) { notice(e.message); } };
for (const type of ['dragover', 'drop']) window.addEventListener(type, event => event.preventDefault());
$('drop-zone').ondragover = event => { event.preventDefault(); $('drop-zone').classList.add('dragging'); };
$('drop-zone').ondragleave = () => $('drop-zone').classList.remove('dragging');
$('drop-zone').ondrop = async event => {
  event.preventDefault(); $('drop-zone').classList.remove('dragging');
  const fallback = Array.from(event.dataTransfer.files);
  const roots = Array.from(event.dataTransfer.items).map(item => item.webkitGetAsEntry?.()).filter(Boolean);
  try { const files = []; for (const root of roots) files.push(...await walkEntry(root)); await uploadFiles(roots.length ? files : fallback); } catch (e) { notice(`Nie można odczytać folderu: ${e.message}`); }
};
window.addEventListener('beforeunload', event => { if (uploading) { event.preventDefault(); event.returnValue = ''; } });
const token = location.hash.slice(1);
if (token) history.replaceState(null, '', location.pathname + location.search);
connect(token).catch(e => { $('login').hidden = false; $('workspace').hidden = true; if (token) $('login-error').textContent = e.message; });
