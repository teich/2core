// Static files for the web app. Every file under web/ is served at its own path
// and every module under lib/ at /lib/<name>, so adding a frontend file needs no
// registration here or in the service worker.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = fileURLToPath(new URL('../web/', import.meta.url));
const LIB = fileURLToPath(new URL('../lib/', import.meta.url));
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};
const SAFE = /^\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
// The service worker's cache name and shell list are filled in when it is served.
const SW_PLACEHOLDER = "{ version: 'dev', shell: ['/'] }";

const contentType = file => {
  const type = TYPES[extname(file)];
  return (
    type &&
    (type.startsWith('text/') || type.includes('json') || type.includes('svg') ? `${type}; charset=utf-8` : type)
  );
};

/** Maps a URL path to a file on disk, or null when it is not a servable asset. */
export function resolveAsset(path) {
  if (path === '/') return { file: join(WEB, 'index.html'), type: contentType('index.html') };
  // No dotfiles, no `..`, no empty segments: only plain names under web/ or lib/.
  if (!SAFE.test(path)) return null;
  const [root, rest] = path.startsWith('/lib/') ? [LIB, path.slice(5)] : [WEB, path.slice(1)];
  if (root === LIB && rest.includes('/')) return null;
  const type = contentType(rest);
  return type ? { file: join(root, ...rest.split('/')), type } : null;
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter(e => e.isFile() && !e.name.startsWith('.') && TYPES[extname(e.name)])
    .map(e => join(e.parentPath, e.name))
    .sort();
}

/** URL paths the service worker caches as the offline launch shell. */
export async function shellFiles() {
  const web = (await walk(WEB))
    .map(file => `/${relative(WEB, file).split(sep).join('/')}`)
    .filter(path => path !== '/index.html' && path !== '/service-worker.js');
  const lib = (await walk(LIB))
    .filter(file => !relative(LIB, file).includes(sep))
    .map(file => `/lib/${relative(LIB, file)}`);
  return ['/', ...web, ...lib];
}

/** The service worker with its shell list and a content-derived cache version. */
export async function serviceWorker() {
  const source = await readFile(join(WEB, 'service-worker.js'), 'utf8');
  if (!source.includes(SW_PLACEHOLDER)) throw new Error('service-worker.js is missing its build placeholder');
  const shell = await shellFiles();
  const hash = createHash('sha256').update(source);
  for (const path of shell) hash.update(path).update(await readFile(resolveAsset(path).file));
  const build = JSON.stringify({ version: hash.digest('hex').slice(0, 12), shell });
  return source.replace(SW_PLACEHOLDER, build);
}

/** Reads an asset, or returns null when the path is unknown or missing. */
export async function readAsset(path) {
  if (path === '/service-worker.js') return { type: contentType('service-worker.js'), data: await serviceWorker() };
  const asset = resolveAsset(path);
  if (!asset) return null;
  try {
    return { type: asset.type, data: await readFile(asset.file) };
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'EISDIR') return null;
    throw e;
  }
}
