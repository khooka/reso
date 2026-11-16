/* 레조넌스 개인 실행기 — 화면·설치·세이브 백업 */
'use strict';

(() => {
  const LAUNCHER_VERSION = '1.0.2';
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  const BASE = new URL('./', location.href);
  const PACK_CACHE = 'reso-packs-v1';
  const META_CACHE = 'reso-meta-v1';
  const metaUrl = (name) => new URL('__meta/' + name, BASE).href;
  const packUrl = (id) => new URL('__packs/' + id + '.bin', BASE).href;

  const SETTINGS_KEY = 'reso.launcher.settings.v1';
  const LAST_BACKUP_KEY = 'reso.launcher.lastBackup';
  const IGNORE_BROWSER_KEY = 'reso.launcher.ignoreBrowser';
  const SAVE_KEY_RE = /^rcb\.[A-Za-z0-9_.-]+$/;
  const MIRROR_KEY = 'rcb.androidMirrorAt';
  const BACKUP_FORMAT = 'pokemon-resonance-backup';
  const PACK_ID_RE = /^[a-f0-9]{64}$/;

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = navigator.standalone === true ||
    matchMedia('(display-mode: standalone)').matches ||
    matchMedia('(display-mode: fullscreen)').matches;

  const state = {
    release: null,     // 서버의 최신 버전 정보
    active: null,      // 기기에 설치된 버전
    busy: false,
    abort: null,
    swReady: null,
  };

  // ---------------------------------------------------------------------------
  // 공통 도구

  let toastTimer = 0;
  function toast(message, isError = false) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.toggle('error', isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), isError ? 6000 : 3500);
  }

  function formatBytes(n) {
    if (!Number.isFinite(n)) return '?';
    if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + 'GB';
    if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(0) + 'MB';
    if (n >= 1024) return (n / 1024).toFixed(0) + 'KB';
    return n + 'B';
  }

  function formatAgo(ms) {
    const min = Math.floor((Date.now() - ms) / 60000);
    if (min < 1) return '방금';
    if (min < 60) return min + '분 전';
    const h = Math.floor(min / 60);
    if (h < 24) return h + '시간 전';
    return Math.floor(h / 24) + '일 전';
  }

  async function sha256Hex(data) {
    const digest = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function readMetaJson(name) {
    const cache = await caches.open(META_CACHE);
    const res = await cache.match(metaUrl(name));
    if (!res) return null;
    try { return await res.json(); } catch { return null; }
  }

  async function writeMetaJson(name, value) {
    const cache = await caches.open(META_CACHE);
    await cache.put(metaUrl(name), new Response(JSON.stringify(value), {
      headers: { 'Content-Type': 'application/json' },
    }));
  }

  async function deleteMeta(name) {
    const cache = await caches.open(META_CACHE);
    await cache.delete(metaUrl(name));
  }

  function setMessage(text, kind = '') {
    const el = $('#st-message');
    el.hidden = !text;
    el.textContent = text || '';
    el.className = 'message' + (kind ? ' ' + kind : '');
  }

  function tellServiceWorker(message) {
    const sw = navigator.serviceWorker?.controller || null;
    return new Promise((resolve) => {
      const target = sw || state.swRegistration?.active;
      if (!target) return resolve(false);
      const channel = new MessageChannel();
      const timer = setTimeout(() => resolve(false), 3000);
      channel.port1.onmessage = () => { clearTimeout(timer); resolve(true); };
      target.postMessage(message, [channel.port2]);
    });
  }

  // ---------------------------------------------------------------------------
  // 환경 확인

  function checkSupport() {
    const missing = [];
    if (!('serviceWorker' in navigator)) missing.push('서비스 워커');
    if (!('caches' in window)) missing.push('Cache Storage');
    if (!window.crypto?.subtle) missing.push('Web Crypto(HTTPS 필요)');
    if (typeof DecompressionStream !== 'function') missing.push('DecompressionStream');
    if (missing.length) {
      $('#notice-unsupported').hidden = false;
      $('#unsupported-reason').textContent =
        '다음 기능이 없습니다: ' + missing.join(', ') + '. iOS 17 이상 Safari 또는 최신 Chrome에서 HTTPS 주소로 여세요.';
      return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // 버전 정보와 위치표

  async function loadRelease() {
    try {
      const res = await fetch(new URL('release.json', BASE), { cache: 'no-store' });
      if (res.ok) {
        const release = await res.json();
        if (release && PACK_ID_RE.test(release.buildId || '') && typeof release.manifestUrl === 'string') {
          await writeMetaJson('last-release.json', release);
          return release;
        }
      }
    } catch { /* 오프라인 */ }
    return await readMetaJson('last-release.json');
  }

  function validateManifest(m) {
    if (!m || m.format !== 1 || !Array.isArray(m.packs) || !m.files || typeof m.files !== 'object') {
      throw new Error('위치표 형식이 올바르지 않습니다.');
    }
    if (m.packs.length < 1 || m.packs.length > 5000) throw new Error('위치표의 팩 개수가 이상합니다.');
    let total = 0;
    for (const p of m.packs) {
      if (!p || !PACK_ID_RE.test(p.id) || !Number.isInteger(p.bytes) || p.bytes < 1 || p.bytes > 32 * 1024 * 1024) {
        throw new Error('위치표의 팩 정보가 이상합니다.');
      }
      total += p.bytes;
    }
    if (Number.isInteger(m.totalBytes) && m.totalBytes !== total) throw new Error('위치표의 전체 크기가 맞지 않습니다.');
    if (!m.files['index.html']) throw new Error('위치표에 게임 시작 파일(index.html)이 없습니다.');
  }

  // 위치표를 기기에 저장된 것에서 찾거나, 서버에서 받아 SHA-256을 확인한 뒤 저장한다.
  async function ensureManifest(release) {
    const name = 'manifest-' + release.buildId + '.json';
    const cached = await readMetaJson(name);
    if (cached) return cached;
    const res = await fetch(new URL(release.manifestUrl, BASE), { cache: 'no-store' });
    if (!res.ok) throw new Error('위치표를 받지 못했습니다 (HTTP ' + res.status + ').');
    const buf = await res.arrayBuffer();
    const hash = await sha256Hex(buf);
    if (hash !== release.buildId) throw new Error('위치표 해시가 버전 정보와 다릅니다. 파일이 바뀌었거나 손상되었습니다.');
    const manifest = JSON.parse(new TextDecoder().decode(buf));
    validateManifest(manifest);
    const cache = await caches.open(META_CACHE);
    await cache.put(metaUrl(name), new Response(buf, { headers: { 'Content-Type': 'application/json' } }));
    return manifest;
  }

  // 고급: 위치표 JSON을 직접 고른 경우
  async function useManifestFile(file) {
    const buf = await file.arrayBuffer();
    const hash = await sha256Hex(buf);
    const manifest = JSON.parse(new TextDecoder().decode(buf));
    validateManifest(manifest);
    const cache = await caches.open(META_CACHE);
    await cache.put(metaUrl('manifest-' + hash + '.json'), new Response(buf, { headers: { 'Content-Type': 'application/json' } }));
    const release = {
      format: 1,
      buildId: hash,
      gameVersion: String(manifest.gameVersion || '?'),
      manifestUrl: 'manifest-' + hash + '.json',
      manual: true,
    };
    await writeMetaJson('manual-release.json', release);
    state.release = release;
    return release;
  }

  // ---------------------------------------------------------------------------
  // 상태 표시

  async function refreshStatus() {
    state.active = await readMetaJson('active.json');
    const fetched = await loadRelease();
    const manual = await readMetaJson('manual-release.json');
    // 위치표를 직접 고른 경우 그것을 우선한다 (설치가 끝나면 지워짐)
    state.release = manual || fetched || null;

    const active = state.active;
    const release = state.release;
    $('#st-installed').textContent = active ? `${active.gameVersion} · ${active.buildId.slice(0, 8)}` : '없음';
    $('#st-latest').textContent = release ? `${release.gameVersion} · ${release.buildId.slice(0, 8)}` : '확인 못 함';

    try {
      const est = await navigator.storage?.estimate?.();
      if (est) {
        $('#st-storage').textContent = `${formatBytes(est.usage)} 사용` + (est.quota ? ` / 남은 ${formatBytes(est.quota - est.usage)}` : '');
      } else {
        $('#st-storage').textContent = '확인 못 함';
      }
    } catch { $('#st-storage').textContent = '확인 못 함'; }

    const saveKeys = listSaveKeys();
    const last = Number(localStorage.getItem(LAST_BACKUP_KEY) || 0);
    $('#st-backup').textContent = saveKeys.length === 0 ? '세이브 없음' : (last ? formatAgo(last) : '한 번도 안 함');

    $('#btn-play').disabled = !active || state.busy;
    $('#btn-undo-import').hidden = !(await readMetaJson('before-import.json'));

    if (!active) {
      setMessage(release ? '아직 설치되지 않았습니다. 아래에서 packs.zip을 고르세요.' : '버전 정보를 읽지 못했습니다. 인터넷 연결을 확인하거나, 고급 메뉴에서 위치표 파일을 직접 고르세요.', 'warn');
    } else if (release && release.buildId !== active.buildId) {
      setMessage(`새 버전(${release.gameVersion})이 있습니다. 원래 사이트에서 새 packs.zip을 받아 아래에서 고르면 바뀐 팩만 추가로 저장합니다. 지금 버전으로 계속 플레이할 수도 있습니다.`, 'warn');
    } else if (saveKeys.length && (!last || Date.now() - last > 7 * 86400000)) {
      setMessage('세이브 백업을 내보낸 지 오래됐습니다. 가끔 백업해 두세요.', 'warn');
    } else {
      setMessage('');
    }
  }

  // ---------------------------------------------------------------------------
  // 설치

  function setProgress(done, total, text) {
    $('#progress').hidden = false;
    const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
    $('#progress-bar').style.width = pct.toFixed(1) + '%';
    $('#progress-text').textContent = text;
  }

  function setBusy(busy) {
    state.busy = busy;
    $('#lbl-zip').classList.toggle('disabled', busy);
    $('#btn-play').disabled = busy || !state.active;
    $('#btn-wipe').disabled = busy;
    $('#btn-cancel').hidden = !busy;
  }

  // 고른 파일들에서 "팩 id → 꺼내는 방법" 표를 만든다.
  async function buildSources(files) {
    const sources = new Map();
    for (const file of files) {
      const lower = file.name.toLowerCase();
      if (lower.endsWith('.zip')) {
        const entries = await ZipReader.readIndex(file);
        for (const entry of entries) {
          if (entry.name.startsWith('__MACOSX/')) continue;
          const base = entry.name.split(/[\\/]/).pop().toLowerCase();
          const m = /^([a-f0-9]{64})\.bin$/.exec(base);
          if (m && !sources.has(m[1])) sources.set(m[1], { kind: 'zip', file, entry });
        }
      } else {
        const m = /^([a-f0-9]{64})\.bin$/.exec(lower);
        if (m && !sources.has(m[1])) sources.set(m[1], { kind: 'bin', file });
      }
    }
    return sources;
  }

  async function installedPackIds() {
    const cache = await caches.open(PACK_CACHE);
    const ids = new Set();
    for (const req of await cache.keys()) {
      const m = /\/__packs\/([a-f0-9]{64})\.bin$/.exec(new URL(req.url).pathname);
      if (m) ids.add(m[1]);
    }
    return { cache, ids };
  }

  async function install(files) {
    if (state.busy) return;
    if (!state.release) {
      toast('버전 정보가 없어 설치할 수 없습니다. 인터넷 연결을 확인하거나 고급 메뉴에서 위치표를 직접 고르세요.', true);
      return;
    }
    setBusy(true);
    const abort = new AbortController();
    state.abort = abort;
    try {
      setProgress(0, 1, '위치표 확인 중…');
      const release = state.release;
      const manifest = await ensureManifest(release);

      setProgress(0, 1, 'ZIP 목차 읽는 중…');
      const sources = await buildSources(files);
      if (sources.size === 0) throw new Error('고른 파일에서 팩(.bin)을 찾지 못했습니다. 원래 사이트에서 받은 packs.zip이 맞는지 확인하세요.');

      const { cache, ids: have } = await installedPackIds();
      const todo = manifest.packs.filter((p) => !have.has(p.id));
      const missing = todo.filter((p) => !sources.has(p.id));
      if (missing.length) {
        throw new Error(`이 버전(${release.gameVersion})에 필요한 팩 ${missing.length}개가 고른 파일에 없습니다. 원래 사이트의 최신 packs.zip인지 확인하세요.`);
      }

      const totalBytes = todo.reduce((s, p) => s + p.bytes, 0);
      try {
        const est = await navigator.storage?.estimate?.();
        if (est?.quota && est.quota - est.usage < totalBytes * 1.05) {
          const ok = confirm(`저장 공간이 부족할 수 있습니다.\n필요: ${formatBytes(totalBytes)} / 남은 공간: ${formatBytes(est.quota - est.usage)}\n계속할까요?`);
          if (!ok) throw new DOMException('취소됨', 'AbortError');
        }
      } catch (e) { if (e.name === 'AbortError') throw e; }
      try { await navigator.storage?.persist?.(); } catch { /* 무시 */ }

      let doneBytes = 0;
      for (let i = 0; i < todo.length; i++) {
        if (abort.signal.aborted) throw new DOMException('취소됨', 'AbortError');
        const pack = todo[i];
        setProgress(doneBytes, totalBytes, `팩 저장 중 ${i + 1}/${todo.length} · ${formatBytes(doneBytes)} / ${formatBytes(totalBytes)}`);
        const src = sources.get(pack.id);
        const bytes = src.kind === 'zip'
          ? await ZipReader.extract(src.file, src.entry, abort.signal)
          : new Uint8Array(await src.file.arrayBuffer());
        if (bytes.byteLength !== pack.bytes) throw new Error(`팩 크기가 다릅니다 (${pack.id.slice(0, 8)}). 파일이 손상되었을 수 있습니다.`);
        const hash = await sha256Hex(bytes);
        if (hash !== pack.id) throw new Error(`팩 내용이 위치표와 다릅니다 (${pack.id.slice(0, 8)}). 파일이 손상되었을 수 있습니다.`);
        await cache.put(packUrl(pack.id), new Response(bytes, {
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.byteLength) },
        }));
        doneBytes += pack.bytes;
      }

      setProgress(totalBytes, totalBytes, '마무리 중…');
      await writeMetaJson('active.json', {
        buildId: release.buildId,
        gameVersion: String(manifest.gameVersion || release.gameVersion || '?'),
        installedAt: new Date().toISOString(),
      });
      await pruneOld(manifest, release.buildId);
      await tellServiceWorker({ type: 'RESO_RELOAD_MANIFEST' });
      setProgress(1, 1, `설치 완료 · 새로 저장한 팩 ${todo.length}개 (${formatBytes(totalBytes)})`);
      toast('설치가 끝났습니다. 게임을 시작할 수 있습니다.');
    } catch (err) {
      if (err?.name === 'AbortError') {
        setProgress(0, 1, '취소했습니다. 이미 저장한 팩은 남아 있어서 다시 고르면 이어서 설치합니다.');
      } else {
        console.error(err);
        setProgress(0, 1, '설치 실패: ' + (err?.message || err));
        toast('설치 실패: ' + (err?.message || err), true);
      }
    } finally {
      state.abort = null;
      setBusy(false);
      await refreshStatus();
    }
  }

  // 지금 버전에 안 쓰는 팩·위치표를 지운다.
  async function pruneOld(manifest, buildId) {
    const keep = new Set(manifest.packs.map((p) => p.id));
    const packCache = await caches.open(PACK_CACHE);
    for (const req of await packCache.keys()) {
      const m = /\/__packs\/([a-f0-9]{64})\.bin$/.exec(new URL(req.url).pathname);
      if (m && !keep.has(m[1])) await packCache.delete(req);
    }
    const meta = await caches.open(META_CACHE);
    for (const req of await meta.keys()) {
      const m = /\/__meta\/manifest-([a-f0-9]{64})\.json$/.exec(new URL(req.url).pathname);
      if (m && m[1] !== buildId) await meta.delete(req);
    }
    await deleteMeta('manual-release.json');
  }

  async function wipeGameData() {
    if (state.busy) return;
    if (!confirm('설치된 게임 데이터(약 1GB)를 지웁니다. 세이브는 남습니다. 계속할까요?')) return;
    await caches.delete(PACK_CACHE);
    const meta = await caches.open(META_CACHE);
    for (const req of await meta.keys()) {
      if (!/before-import\.json$/.test(req.url)) await meta.delete(req);
    }
    await tellServiceWorker({ type: 'RESO_RELOAD_MANIFEST' });
    $('#progress').hidden = true;
    toast('게임 데이터를 지웠습니다.');
    await refreshStatus();
  }

  // ---------------------------------------------------------------------------
  // 세이브 백업 (게임과 원래 실행기가 쓰는 pokemon-resonance-backup 형식)

  function listSaveKeys() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && SAVE_KEY_RE.test(k) && k !== MIRROR_KEY) keys.push(k);
    }
    return keys.sort();
  }

  function snapshotSaves() {
    const data = {};
    for (const k of listSaveKeys()) data[k] = localStorage.getItem(k) ?? '';
    return data;
  }

  function stamp(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  async function exportBackup() {
    const data = snapshotSaves();
    if (Object.keys(data).length === 0) {
      toast('저장된 세이브가 없습니다.');
      return;
    }
    const json = JSON.stringify({
      format: BACKUP_FORMAT,
      version: 1,
      createdAt: new Date().toISOString(),
      source: 'reso-personal-launcher',
      data,
    }, null, 2);
    const name = `resonance-backup-${stamp()}.json`;
    const file = new File([json], name, { type: 'application/json' });

    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name });
        localStorage.setItem(LAST_BACKUP_KEY, String(Date.now()));
        toast('백업을 내보냈습니다.');
      } catch (e) {
        if (e?.name !== 'AbortError') toast('내보내기 실패: ' + (e?.message || e), true);
      }
    } else {
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      localStorage.setItem(LAST_BACKUP_KEY, String(Date.now()));
      toast('백업 파일을 저장했습니다: ' + name);
    }
    refreshStatus();
  }

  function validateBackup(value) {
    if (value?.format !== BACKUP_FORMAT || value.version !== 1 || !value.data ||
        typeof value.data !== 'object' || Array.isArray(value.data)) {
      throw new Error('레조넌스 세이브 백업 파일이 아닙니다.');
    }
    const entries = Object.entries(value.data).filter(([k]) => k !== MIRROR_KEY);
    if (!entries.length) throw new Error('백업 파일에 세이브가 없습니다.');
    if (entries.length > 300) throw new Error('백업 파일의 항목이 너무 많습니다.');
    for (const [k, v] of entries) {
      if (!SAVE_KEY_RE.test(k) || typeof v !== 'string') throw new Error('백업 파일에 이상한 항목이 있습니다: ' + k);
    }
    return Object.fromEntries(entries);
  }

  function replaceSaves(next) {
    const previous = snapshotSaves();
    try {
      for (const k of Object.keys(previous)) localStorage.removeItem(k);
      for (const [k, v] of Object.entries(next)) localStorage.setItem(k, v);
    } catch (err) {
      for (const k of Object.keys(next)) localStorage.removeItem(k);
      for (const [k, v] of Object.entries(previous)) localStorage.setItem(k, v);
      throw err;
    }
  }

  async function importBackup(file) {
    if (file.size > 16 * 1024 * 1024) throw new Error('백업 파일이 너무 큽니다.');
    let parsed;
    try { parsed = JSON.parse(await file.text()); } catch { throw new Error('JSON 파일을 읽지 못했습니다.'); }
    const next = validateBackup(parsed);
    const current = snapshotSaves();
    const when = parsed.createdAt ? new Date(parsed.createdAt).toLocaleString('ko-KR') : '알 수 없음';
    const msg = `세이브를 백업 파일로 바꿉니다.\n\n백업 만든 시각: ${when}\n백업 항목: ${Object.keys(next).length}개\n지금 세이브 항목: ${Object.keys(current).length}개\n\n지금 세이브는 기기에 따로 보관해 두고, 나중에 되돌릴 수 있습니다.`;
    if (!confirm(msg)) return;
    if (Object.keys(current).length) {
      await writeMetaJson('before-import.json', { savedAt: new Date().toISOString(), data: current });
    }
    replaceSaves(next);
    toast('세이브를 가져왔습니다.');
    await refreshStatus();
  }

  async function undoImport() {
    const snap = await readMetaJson('before-import.json');
    if (!snap?.data) return;
    const when = snap.savedAt ? new Date(snap.savedAt).toLocaleString('ko-KR') : '';
    if (!confirm(`가져오기 전 세이브(${when})로 되돌립니다. 지금 세이브는 사라집니다. 계속할까요?`)) return;
    replaceSaves(snap.data);
    await deleteMeta('before-import.json');
    toast('가져오기 전 세이브로 되돌렸습니다.');
    await refreshStatus();
  }

  // ---------------------------------------------------------------------------
  // 화면 여백 설정

  const DEFAULT_SETTINGS = { pad: 'sides', extra: 0, menuSide: 'left', autoStart: false };

  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      return {
        pad: ['sides', 'safe', 'off'].includes(s.pad) ? s.pad : DEFAULT_SETTINGS.pad,
        extra: Number.isFinite(s.extra) ? Math.max(0, Math.min(40, s.extra)) : DEFAULT_SETTINGS.extra,
        menuSide: s.menuSide === 'right' ? 'right' : 'left',
        autoStart: s.autoStart === true,
      };
    } catch { return { ...DEFAULT_SETTINGS }; }
  }

  let settings = loadSettings();

  function applySettings() {
    const wrap = $('#game-wrap');
    wrap.classList.remove('pad-sides', 'pad-safe', 'pad-off');
    wrap.classList.add('pad-' + settings.pad);
    wrap.classList.toggle('menu-right', settings.menuSide === 'right');
    wrap.style.setProperty('--x', settings.extra + 'px');
    for (const seg of $$('.segmented[data-setting="pad"]')) {
      for (const b of seg.querySelectorAll('button')) b.classList.toggle('on', b.dataset.value === settings.pad);
    }
    for (const r of $$('input[data-setting="extra"]')) r.value = String(settings.extra);
    for (const o of $$('output[data-out="extra"]')) o.textContent = settings.extra + 'px';
    $('#opt-autostart').checked = settings.autoStart;
  }

  function saveSettings(patch) {
    settings = { ...settings, ...patch };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* 무시 */ }
    applySettings();
  }

  // ---------------------------------------------------------------------------
  // 게임 실행

  async function play() {
    if (!state.active || state.busy) return;
    await state.swReady;
    document.body.classList.add('playing');
    $('#game-wrap').hidden = false;
    $('#game-menu').hidden = true;
    const frame = $('#game-frame');
    frame.src = new URL('game/index.html?mobile=1', BASE).href;
    frame.focus();
  }

  function exitGame() {
    if (!confirm('게임 안에서 저장했나요?\n실행기로 돌아가면 게임이 종료됩니다.')) return;
    $('#game-frame').src = 'about:blank';
    $('#game-menu').hidden = true;
    $('#game-wrap').hidden = true;
    document.body.classList.remove('playing');
    refreshStatus();
  }

  // ---------------------------------------------------------------------------
  // 이벤트 연결

  function wire() {
    $('#btn-play').addEventListener('click', play);

    $('#pick-zip').addEventListener('change', (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      if (files.length) install(files);
    });
    $('#btn-cancel').addEventListener('click', () => state.abort?.abort());

    $('#btn-export').addEventListener('click', exportBackup);
    $('#btn-menu-export').addEventListener('click', exportBackup);
    $('#pick-backup').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try { await importBackup(file); } catch (err) { toast(err.message || String(err), true); }
    });
    $('#btn-undo-import').addEventListener('click', undoImport);

    $('#pick-manifest').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const release = await useManifestFile(file);
        toast(`위치표를 읽었습니다 (버전 ${release.gameVersion}). 이제 packs.zip을 고르세요.`);
        $('#st-latest').textContent = `${release.gameVersion} · ${release.buildId.slice(0, 8)} (직접 선택)`;
      } catch (err) { toast(err.message || String(err), true); }
    });
    $('#btn-wipe').addEventListener('click', wipeGameData);

    for (const seg of $$('.segmented[data-setting="pad"]')) {
      seg.addEventListener('click', (e) => {
        const v = e.target.closest('button')?.dataset.value;
        if (v) saveSettings({ pad: v });
      });
    }
    for (const r of $$('input[data-setting="extra"]')) {
      r.addEventListener('input', () => saveSettings({ extra: Number(r.value) }));
    }

    $('#opt-autostart').addEventListener('change', (e) => saveSettings({ autoStart: e.target.checked }));

    $('#btn-menu').addEventListener('click', () => { $('#game-menu').hidden = false; });
    $('#btn-menu-close').addEventListener('click', () => { $('#game-menu').hidden = true; $('#game-frame').focus(); });
    $('#game-menu').addEventListener('click', (e) => {
      if (e.target.id === 'game-menu') { $('#game-menu').hidden = true; $('#game-frame').focus(); }
    });
    $('#btn-menu-side').addEventListener('click', () => saveSettings({ menuSide: settings.menuSide === 'left' ? 'right' : 'left' }));
    $('#btn-exit').addEventListener('click', exitGame);

    $('#btn-ignore-browser').addEventListener('click', () => {
      sessionStorage.setItem(IGNORE_BROWSER_KEY, '1');
      $('#notice-browser').hidden = true;
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !document.body.classList.contains('playing') && !state.busy) refreshStatus();
    });
  }

  // ---------------------------------------------------------------------------
  // 시작

  async function boot() {
    $('#st-version').textContent = '실행기 ' + LAUNCHER_VERSION;
    applySettings();
    wire();
    if (!checkSupport()) {
      $('#install-card').hidden = true;
      return;
    }
    if (isIOS && !isStandalone && !sessionStorage.getItem(IGNORE_BROWSER_KEY)) {
      $('#notice-browser').hidden = false;
    }
    state.swReady = navigator.serviceWorker.register('sw.js', { scope: './' })
      .then((reg) => { state.swRegistration = reg; return navigator.serviceWorker.ready; })
      .catch((err) => {
        console.error(err);
        toast('서비스 워커 등록 실패: ' + (err?.message || err), true);
      });
    await state.swReady;
    await refreshStatus();

    const updateWaiting = state.release && state.active && state.release.buildId !== state.active.buildId;
    const browserNoticeShown = !$('#notice-browser').hidden;
    if (settings.autoStart && state.active && !updateWaiting && !browserNoticeShown) {
      play();
    }
  }

  boot();
})();
