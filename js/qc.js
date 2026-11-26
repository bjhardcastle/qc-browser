// Everything the app needs from the browser: S3 listing, IndexedDB, keys, preloading, files, sync transport.
window.qc = (() => {
  // ---- S3 listing (parsed here: far faster than shipping XML into .NET) ----
  async function listPage(bucket, prefix, delimiter, token) {
    let url = `${bucket}?list-type=2&prefix=${encodeURIComponent(prefix)}`;
    if (delimiter) url += `&delimiter=${encodeURIComponent(delimiter)}`;
    if (token) url += `&continuation-token=${encodeURIComponent(token)}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`S3 ${res.status} ${res.statusText}`);
    const text = await res.text();
    const keys = [], etags = [], prefixes = [];
    for (const m of text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      keys.push(unxml((m[1].match(/<Key>([^<]*)<\/Key>/) || [])[1] || ''));
      etags.push(unxml((m[1].match(/<ETag>([^<]*)<\/ETag>/) || [])[1] || '').replace(/"/g, ''));
    }
    for (const m of text.matchAll(/<CommonPrefixes><Prefix>([^<]*)<\/Prefix><\/CommonPrefixes>/g)) prefixes.push(unxml(m[1]));
    const next = /<IsTruncated>true<\/IsTruncated>/.test(text) ? unxml((text.match(/<NextContinuationToken>([^<]*)</) || [])[1] || '') : null;
    return { keys, etags, prefixes, next };
  }
  const unxml = s => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e]);

  async function listAll(bucket, prefix) {
    const keys = [], etags = [];
    let token = null;
    do { const p = await listPage(bucket, prefix, null, token); keys.push(...p.keys); etags.push(...p.etags); token = p.next; } while (token);
    return { keys, etags };
  }

  // every stored version (and delete marker) of one key: the bucket is versioned and lets anyone list versions
  async function listVersions(bucket, key) {
    const out = [];
    let keyMarker = null, idMarker = null;
    for (let page = 0; page < 20; page++) {
      let url = `${bucket}?versions&prefix=${encodeURIComponent(key)}`;
      if (keyMarker) url += `&key-marker=${encodeURIComponent(keyMarker)}&version-id-marker=${encodeURIComponent(idMarker)}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`S3 ${res.status} ${res.statusText}`);
      const text = await res.text();
      for (const m of text.matchAll(/<(Version|DeleteMarker)>([\s\S]*?)<\/\1>/g)) {
        const body = m[2], get = tag => unxml((body.match(new RegExp(`<${tag}>([^<]*)</${tag}>`)) || [])[1] || '');
        if (get('Key') !== key) continue;   // the prefix also matches longer keys (x_1.png vs x_10.png)
        out.push({ id: get('VersionId'), at: Date.parse(get('LastModified')) || 0, eTag: get('ETag').replace(/"/g, ''),
          size: Number(get('Size')) || 0, isLatest: get('IsLatest') === 'true', isDeleteMarker: m[1] === 'DeleteMarker' });
      }
      if (!/<IsTruncated>true<\/IsTruncated>/.test(text)) break;
      keyMarker = unxml((text.match(/<NextKeyMarker>([^<]*)</) || [])[1] || '');
      idMarker = unxml((text.match(/<NextVersionIdMarker>([^<]*)</) || [])[1] || '');
      if (keyMarker !== key) break;            // past this key
    }
    return out;
  }

  async function listFolders(bucket, prefix) {
    const out = [];
    let token = null;
    do { const p = await listPage(bucket, prefix, '/', token); out.push(...p.prefixes); token = p.next; } while (token);
    return out;
  }

  // every group/plot under root: one request for the groups, then one per group, in parallel
  async function discoverPlots(bucket, root) {
    const groups = await listFolders(bucket, root);
    const plots = await Promise.all(groups.map(g => listFolders(bucket, g)));
    return plots.flat().map(p => p.slice(root.length).replace(/\/$/, '')).sort();
  }

  // ---- IndexedDB: 'kv' (listing cache) and 'ratings' (one record per image) ----
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((resolve, reject) => {
      const open = indexedDB.open('qc-browser', 1);
      open.onupgradeneeded = () => { open.result.createObjectStore('kv'); open.result.createObjectStore('ratings', { keyPath: 'k' }); };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    return dbp;
  }
  const req = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  async function kvGet(key) { try { return (await req((await db()).transaction('kv').objectStore('kv').get(key))) ?? null; } catch { return null; } }
  async function kvSet(key, value) { try { await req((await db()).transaction('kv', 'readwrite').objectStore('kv').put(value, key)); } catch { } }
  async function ratingsAll() { try { return await req((await db()).transaction('ratings').objectStore('ratings').getAll()); } catch { return []; } }
  async function ratingsPut(list) {
    try {
      const tx = (await db()).transaction('ratings', 'readwrite');
      const s = tx.objectStore('ratings');
      for (const r of list) s.put(r);
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    } catch (e) { console.error('saving ratings failed', e); }
  }

  // ---- local settings ----
  const get = k => { try { return localStorage.getItem('qc.' + k); } catch { return null; } };
  const set = (k, v) => { try { v == null ? localStorage.removeItem('qc.' + k) : localStorage.setItem('qc.' + k, v); } catch { } };

  // ---- keyboard: one listener, ignored while typing in a field ----
  let keyRef = null;
  const handled = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', 'Enter', 'Backspace', 'Escape',
    'p', 'f', 'x', 'u', 'n', 'j', 'k', 'z', 'c', '?', 'm', 'Home', 'End', '1', '2', '/', ',', 'v', 'b']);
  document.addEventListener('keydown', e => {
    if (!keyRef || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (typing) {
      if (e.key === 'Escape' || (e.key === 'Enter' && t.dataset.enterBlur)) { t.blur(); e.preventDefault(); keyRef.invokeMethodAsync('OnKey', e.key === 'Enter' ? 'note-done' : 'Escape', false); }
      return;
    }
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (!handled.has(key)) return;
    if (t && t.tagName === 'BUTTON' && (key === ' ' || key === 'Enter')) t.blur();
    e.preventDefault();
    keyRef.invokeMethodAsync('OnKey', key, e.shiftKey);
  });

  // ---- image preloading: keep the decoded neighbours alive ----
  const cache = new Map();
  function preload(urls) {
    for (const u of urls) {
      if (cache.has(u)) { const img = cache.get(u); cache.delete(u); cache.set(u, img); continue; }
      const img = new Image();
      img.decoding = 'async';
      img.src = u;
      cache.set(u, img);
    }
    while (cache.size > 24) cache.delete(cache.keys().next().value);
  }

  // ---- files ----
  function download(name, text, mime) {
    const url = URL.createObjectURL(new Blob([text], { type: mime || 'text/plain' }));
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function pickText(accept) {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = accept || '';
      input.onchange = async () => resolve(input.files && input.files[0] ? await input.files[0].text() : null);
      input.addEventListener('cancel', () => resolve(null));
      input.click();
    });
  }
  // null on any failure (network, rate limit, 404), so the caller can fall back; 8 s timeout
  async function fetchCsv(url) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      return res.ok ? await res.text() : null;
    } catch { return null; }
  }
  async function fetchText(url, max) {
    try {
      const res = await fetch(url);
      if (!res.ok) return `(${res.status} ${res.statusText})`;
      const t = await res.text();
      return max && t.length > max ? t.slice(0, max) + '\n…' : t;
    } catch (e) { return `(unreachable: ${e.message})`; }
  }

  // ---- shared ratings through a Google Apps Script web app (see scripts/sync-apps-script.gs) ----
  // text/plain keeps the POST a "simple" request (no CORS preflight, which Apps Script cannot answer).
  async function syncPush(url, token, rows) {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ token, rows }) });
    const body = await res.json();
    if (body.error) throw new Error(body.error);
    return body.added ?? rows.length;
  }
  async function syncPull(url, token, from) {
    const u = new URL(url);
    u.searchParams.set('from', String(from));
    if (token) u.searchParams.set('token', token);
    const res = await fetch(u, { cache: 'no-store' });
    const body = await res.json();
    if (body.error) throw new Error(body.error);
    return { rows: (body.rows || []).map(r => ({ k: String(r[0]), v: String(r[1] ?? ''), by: String(r[2] ?? ''), at: Number(r[3]) || 0, n: String(r[4] ?? ''), e: String(r[6] ?? '') })), next: body.next | 0 };
  }

  return {
    listAll, listVersions, discoverPlots, kvGet, kvSet, ratingsAll, ratingsPut, get, set, preload, download, pickText, fetchText, fetchCsv,
    syncPush, syncPull,
    registerKeys: ref => { keyRef = ref; },
    setQuery: qs => history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '')),
    query: () => location.search,
    focus: id => { const el = document.getElementById(id); if (el) { el.focus(); if (el.select) el.select(); } },
    scrollIntoView: id => { const el = document.getElementById(id); if (el) el.scrollIntoView({ block: 'nearest' }); },
    onVisible: ref => document.addEventListener('visibilitychange', () => ref.invokeMethodAsync('OnVisibility', document.visibilityState === 'visible')),
  };
})();
