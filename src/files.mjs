import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, link, copyFile, unlink } from 'node:fs/promises';

export const MAX_BYTES = 1_000_000_000;
export const TEMP_PREFIX = '.localhost-share-tmp-';
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function segments(value = '') {
  if (typeof value !== 'string' || value.length > 4096 || value.startsWith('/') || value.includes('\\')) throw new HttpError(400, 'Nieprawidłowa ścieżka.');
  if (!value) return [];
  const parts = value.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || p.toLowerCase() === '.localhost-share' || p.toLowerCase().startsWith(TEMP_PREFIX) || /[\x00-\x1f\x7f<>:"|?*]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p) || Buffer.byteLength(p) > 255)) {
    throw new HttpError(400, 'Niedozwolona nazwa pliku lub katalogu.');
  }
  return parts;
}

export async function safePath(root, relative, createParents = false) {
  const parts = segments(relative);
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let stat;
    try { stat = await lstat(current); }
    catch (e) {
      if (e.code !== 'ENOENT') throw e;
      if (createParents && i < parts.length - 1) {
        await mkdir(current).catch(e => { if (e.code !== 'EEXIST') throw e; });
        stat = await lstat(current);
      } else if (createParents && i === parts.length - 1) return current;
      else throw new HttpError(404, 'Nie znaleziono pliku lub katalogu.');
    }
    if (stat.isSymbolicLink()) throw new HttpError(403, 'Dowiązania symboliczne nie są udostępniane.');
    if (i < parts.length - 1 && !stat.isDirectory()) throw new HttpError(409, 'Ścieżka zawiera plik zamiast katalogu.');
    const canonical = await realpath(current);
    if (canonical !== root && !canonical.startsWith(root + path.sep)) throw new HttpError(403, 'Ścieżka poza udostępnionym katalogiem.');
  }
  return current;
}

export async function listFiles(root, relative) {
  const directory = await safePath(root, relative);
  if (!(await lstat(directory)).isDirectory()) throw new HttpError(400, 'To nie jest katalog.');
  const entries = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.name.startsWith(TEMP_PREFIX) || item.isSymbolicLink()) continue;
    try {
      segments(item.name);
      const stat = await lstat(path.join(directory, item.name));
      if (!stat.isDirectory() && !stat.isFile()) continue;
      entries.push({ name: item.name, directory: stat.isDirectory(), size: stat.size, modified: stat.mtime.toISOString(), downloadable: stat.isFile() && stat.size <= MAX_BYTES });
    } catch { /* Inaccessible or non-portable filename. */ }
  }
  return entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name, 'pl', { numeric: true }));
}

export async function publishFile(root, relative, temporary) {
  const destination = await safePath(root, relative, true);
  const parsed = path.parse(destination);
  for (let suffix = 0; suffix < 10000; suffix++) {
    const name = suffix ? `${parsed.name} (${suffix})${parsed.ext}` : parsed.base;
    segments(name);
    const target = path.join(parsed.dir, name);
    try {
      try { await link(temporary, target); }
      catch (e) {
        if (!['ENOSYS', 'EPERM', 'ENOTSUP', 'EXDEV'].includes(e.code)) throw e;
        await copyFile(temporary, target, constants.COPYFILE_EXCL);
      }
      await unlink(temporary);
      return path.relative(root, target).split(path.sep).join('/');
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new HttpError(409, 'Zbyt wiele plików o tej samej nazwie.');
}

export async function openDownload(root, relative) {
  if (!segments(relative).length) throw new HttpError(400, 'Wskaż plik.');
  const target = await safePath(root, relative);
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new HttpError(400, 'To nie jest zwykły plik.');
    if (stat.size > MAX_BYTES) throw new HttpError(413, 'Plik przekracza limit 1 GB.');
    return { handle, stat, name: path.basename(target) };
  } catch (e) { await handle.close(); throw e; }
}
