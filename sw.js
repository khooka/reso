/* 레조넌스 개인 실행기 — 서비스 워커
 *
 * 하는 일
 *  1. 실행기 화면 파일(셸)을 캐시해서 오프라인에서도 열리게 한다.
 *  2. game/ 아래 요청을 기기에 저장된 팩(.bin)에서 잘라서 돌려준다.
 *     게임 데이터는 서버에 없고, 사용자가 고른 packs.zip에서 꺼낸 것만 쓴다.
 *  3. 외부 서버로 요청을 보내지 않는다. (같은 출처 요청만 다룸)
 */
'use strict';

const VERSION = '1.0.5';
const SHELL_CACHE = 'reso-shell-' + VERSION;
const PACK_CACHE = 'reso-packs-v1';
const META_CACHE = 'reso-meta-v1';

const SCOPE = new URL(self.registration.scope);
const BASE = SCOPE.pathname; // 예: "/" 또는 "/reso/"

const SHELL_FILES = [
  './',
  'index.html',
  'launcher.css',
  'launcher.js',
  'zip.js',
  'manifest.webmanifest',
  'icon-180.png',
  'icon-192.png',
  'icon-512.png',
];

// 경로 → 메타 캐시 키 (실제 서버에 없는 가상 주소)
const metaUrl = (name) => new URL('__meta/' + name, SCOPE).href;
const packUrl = (id) => new URL('__packs/' + id + '.bin', SCOPE).href;

// ---------------------------------------------------------------------------
// 설치 / 활성화

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(SHELL_FILES.map((f) => new Request(new URL(f, SCOPE), { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('reso-shell-') && name !== SHELL_CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const type = event.data?.type;
  if (type === 'RESO_RELOAD_MANIFEST') {
    manifestState = null;
    blobCache.clear();
    event.ports[0]?.postMessage({ ok: true });
  }
});

// ---------------------------------------------------------------------------
// 요청 처리

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' && req.method !== 'HEAD') return;
  const url = new URL(req.url);
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(BASE)) return;

  let rel;
  try { rel = decodeURIComponent(url.pathname.slice(BASE.length)); } catch { return; }

  if (rel === 'game' || rel.startsWith('game/')) {
    let path = rel === 'game' ? '' : rel.slice(5);
    if (path === '' || path.endsWith('/')) path += 'index.html';
    event.respondWith(serveGame(path, req));
    return;
  }

  // 위치표·버전 정보: 네트워크 우선 (오프라인이면 캐시)
  if (rel === 'release.json' || /^manifest-[a-f0-9]{64}\.json$/.test(rel)) {
    event.respondWith(networkFirst(req));
    return;
  }

  // 실행기 화면 파일: 캐시 우선
  event.respondWith(cacheFirst(req, rel));
});

async function cacheFirst(req, rel) {
  const cache = await caches.open(SHELL_CACHE);
  const key = rel === '' ? new URL('./', SCOPE).href : req;
  const hit = await cache.match(key, { ignoreSearch: true });
  if (hit) return hit;
  try {
    return await fetch(req);
  } catch {
    if (req.mode === 'navigate') {
      const index = await cache.match(new URL('index.html', SCOPE).href);
      if (index) return index;
    }
    return new Response('오프라인입니다.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

async function networkFirst(req) {
  try {
    return await fetch(req, { cache: 'no-store' });
  } catch {
    // 오프라인: 실행기가 기기에 저장해 둔 값으로 대신 처리한다
    return new Response('{"offline":true}', { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
}

// ---------------------------------------------------------------------------
// 위치표(매니페스트) 읽기 + 경로 보정표 만들기

let manifestState = null; // { manifest, aliases: Map, buildId }

async function loadManifest() {
  if (manifestState) return manifestState;
  const meta = await caches.open(META_CACHE);
  const activeRes = await meta.match(metaUrl('active.json'));
  if (!activeRes) return null;
  const active = await activeRes.json();
  const manRes = await meta.match(metaUrl('manifest-' + active.buildId + '.json'));
  if (!manRes) return null;
  const manifest = await manRes.json();
  manifestState = { manifest, aliases: buildAliases(manifest.files), buildId: active.buildId };
  return manifestState;
}

// 팩 안의 한글 파일명 일부가 CP437로 깨진 채 들어 있다
// (예: "숲을 따라서.ogg"가 "∞ê▓∞¥ä δö░δ¥╝∞ä£.ogg"로 저장됨).
// 게임은 올바른 한글 이름으로 요청하므로, 깨진 이름을 되돌린 표를 만든다.
const CP437_HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
const CP437_REVERSE = new Map([...CP437_HIGH].map((ch, i) => [ch, 0x80 + i]));
const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true });

function unMojibake(path) {
  const bytes = [];
  let changed = false;
  for (const ch of path) {
    const code = ch.codePointAt(0);
    if (code < 0x80) { bytes.push(code); continue; }
    const b = CP437_REVERSE.get(ch);
    if (b === undefined) return null; // CP437로 설명이 안 되는 문자 → 깨진 이름 아님
    bytes.push(b);
    changed = true;
  }
  if (!changed) return null;
  try { return UTF8_STRICT.decode(new Uint8Array(bytes)); } catch { return null; }
}

// 원래 실행기에 있던 개별 보정 (파일명이 아예 다른 경우)
const EXTRA_ALIASES = {
  'assets/Graphics/Characters/trchar071.png': 'assets/Graphics/Characters/NPC 20.png',
};

function buildAliases(files) {
  const aliases = new Map();
  for (const path of Object.keys(files)) {
    // 비ASCII가 없는 경로는 건너뜀
    if (!/[^\x00-\x7f]/.test(path)) continue;
    const fixed = unMojibake(path);
    if (fixed && fixed !== path && !(fixed in files)) aliases.set(fixed, path);
  }
  for (const [from, to] of Object.entries(EXTRA_ALIASES)) {
    if (!(from in files) && to in files) aliases.set(from, to);
  }
  return aliases;
}

const FOLLOWER_RE = /^assets\/Graphics\/Characters\/Followers( shiny)?\/[^/]+\.png$/i;
const FOLLOWER_FALLBACK = 'assets/Graphics/Characters/Followers/000.png';

function resolveEntry(state, path) {
  const files = state.manifest.files;
  let entry = files[path];
  if (!entry) {
    const alias = state.aliases.get(path);
    if (alias) entry = files[alias];
  }
  if (!entry && FOLLOWER_RE.test(path)) entry = files[FOLLOWER_FALLBACK];
  return entry || null;
}

// ---------------------------------------------------------------------------
// 팩 Blob 캐시 (메모리 LRU)

const BLOB_LIMIT = 64 * 1024 * 1024;
const blobCache = new Map(); // id -> Promise<Blob>
let blobBytes = 0;
const blobSizes = new Map();

function getPackBlob(id) {
  let p = blobCache.get(id);
  if (p) {
    blobCache.delete(id); blobCache.set(id, p); // 최근 사용으로 이동
    return p;
  }
  p = (async () => {
    const cache = await caches.open(PACK_CACHE);
    const res = await cache.match(packUrl(id));
    if (!res) return null;
    const blob = await res.blob();
    blobSizes.set(id, blob.size);
    blobBytes += blob.size;
    while (blobBytes > BLOB_LIMIT && blobCache.size > 1) {
      const oldest = blobCache.keys().next().value;
      blobCache.delete(oldest);
      blobBytes -= blobSizes.get(oldest) || 0;
      blobSizes.delete(oldest);
    }
    return blob;
  })();
  p.catch(() => { blobCache.delete(id); });
  blobCache.set(id, p);
  return p;
}

// ---------------------------------------------------------------------------
// 게임 파일 응답

const EXT_MIME = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  css: 'text/css; charset=utf-8', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp', ogg: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav',
  ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
};

function mimeFor(path, entry) {
  const fromManifest = typeof entry[3] === 'string' && entry[3] ? entry[3] : '';
  if (fromManifest) {
    if (/^text\/|javascript|json/.test(fromManifest) && !/charset/i.test(fromManifest)) return fromManifest + '; charset=utf-8';
    return fromManifest;
  }
  const ext = (path.match(/\.([a-z0-9]+)$/i) || [, ''])[1].toLowerCase();
  return EXT_MIME[ext] || 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// 메뉴·미니게임 스와이프 방향 보정 (선택)
//
// 게임의 메뉴 화면(story UI)은 스와이프를 목록 스크롤처럼 처리한다:
// 손가락을 위로 밀면 커서가 아래로, 오른쪽으로 밀면 왼쪽으로 간다.
// 필드 이동(손가락 방향 그대로)과 반대라서, 실행기 설정이 "손가락 방향"이면
// 그 부분의 부호만 바꾼 storyUi 파일을 내준다. 패턴을 못 찾으면(게임 업데이트 등) 원본 그대로.

const STORY_UI_RE = /^app\/storyUi-[^/]+\.js$/;
const patchedTexts = new Map(); // key -> 패치된 글 또는 null(패턴 없음)

function patchSwipeDirection(src) {
  const dragRe = /Math\.trunc\(-(\w+)\/(\w+)\);let (\w+)=Math\.abs\((\w+)\)>Math\.abs\(\1\)\?Math\.trunc\(-\4\/(\w+)\)/g;
  const flingRe = /\.route\((\w+)<0\?"down":"up"\)/g;
  if ((src.match(dragRe) || []).length !== 1 || (src.match(flingRe) || []).length !== 1) return null;
  return src
    .replace(dragRe, 'Math.trunc($1/$2);let $3=Math.abs($4)>Math.abs($1)?Math.trunc($4/$5)')
    .replace(flingRe, '.route($1<0?"up":"down")');
}

async function swipeFollowsFinger() {
  try {
    const meta = await caches.open(META_CACHE);
    const res = await meta.match(metaUrl('settings.json'));
    if (!res) return true; // 기본값: 손가락 방향
    const s = await res.json();
    return s?.swipe !== 'scroll';
  } catch {
    return true;
  }
}

async function patchedStoryUi(path, entry, pack, blob) {
  if (!STORY_UI_RE.test(path) || !(await swipeFollowsFinger())) return null;
  const [, offset, size] = entry;
  const key = pack.id + ':' + offset + ':' + size;
  if (!patchedTexts.has(key)) {
    const src = await blob.slice(offset, offset + size).text();
    patchedTexts.set(key, patchSwipeDirection(src));
  }
  return patchedTexts.get(key);
}

function textResponse(status, message) {
  return new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function serveGame(path, req) {
  const state = await loadManifest();
  if (!state) return textResponse(503, '게임이 아직 설치되지 않았습니다. 실행기에서 packs.zip을 설치하세요.');

  const entry = resolveEntry(state, path);
  if (!entry) return textResponse(404, 'not found: ' + path);

  const [packIndex, offset, size] = entry;
  const pack = state.manifest.packs[packIndex];
  if (!pack) return textResponse(500, 'bad manifest entry: ' + path);

  const blob = await getPackBlob(pack.id);
  if (!blob) {
    return textResponse(503, '게임 데이터 일부가 없습니다. 실행기에서 packs.zip을 다시 설치하세요. (' + pack.id.slice(0, 8) + ')');
  }

  const patched = await patchedStoryUi(path, entry, pack, blob);
  if (patched) {
    return new Response(req.method === 'HEAD' ? null : patched, {
      status: 200,
      headers: { 'Content-Type': mimeFor(path, entry), 'Cache-Control': 'no-cache', 'X-Reso-Patched': 'swipe' },
    });
  }

  const headers = {
    'Content-Type': mimeFor(path, entry),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  };

  let start = 0;
  let end = size - 1; // 포함 범위
  let status = 200;
  const range = req.headers.get('Range');
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === '' && m[2] === '')) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    if (m[1] === '') { // 마지막 N바이트
      const n = Math.min(parseInt(m[2], 10), size);
      start = size - n;
    } else {
      start = parseInt(m[1], 10);
      if (m[2] !== '') end = Math.min(parseInt(m[2], 10), size - 1);
    }
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }

  const length = size === 0 ? 0 : end - start + 1;
  headers['Content-Length'] = String(length);
  if (req.method === 'HEAD') return new Response(null, { status, headers });
  const body = length === 0 ? new Blob([]) : blob.slice(offset + start, offset + start + length);
  return new Response(body, { status, headers });
}
