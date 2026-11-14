/*
 * Content script (isolated world).
 * Menyimpan daftar subscription, menandai kartu,
 * dan berkomunikasi dengan main-world.js, popup, serta background.
 */
(() => {
  'use strict';
  if (window.__YTUC_CONTENT__) return;
  window.__YTUC_CONTENT__ = true;

  const IN = 'ytuc-content';
  const OUT = 'ytuc-main';
  const { DEFAULTS, CARD_SEL, AUTOLOAD } = YTUC;
  const THUMB_SEL = 'ytd-thumbnail, #thumbnail, yt-thumbnail-view-model, .yt-lockup-view-model__content-image, ' +
    '[class*="lockup-view-model"][class*="content-image"], [class*="LockupViewModelContentImage"], #avatar-section, #avatar, ytd-playlist-thumbnail';
  // Nama class lama (kebab-case) dan baru (camelCase, mis. ytContentMetadataViewModelMetadataRow)
  const NAME_SEL = [
    'ytd-channel-name #text', '#channel-name #text', '#channel-title #text', '#byline',
    'yt-content-metadata-view-model > div:first-child > span',
    '[class*="metadata-row"]:first-child > span', '[class*="MetadataRow"]:first-child > span'
  ].join(', ');
  const CHANNEL_LINK = 'a[href^="/@"], a[href^="/channel/"], a[href^="/c/"], a[href^="/user/"]';

  let settings = { ...DEFAULTS };
  const subs = { list: [], ids: new Set(), keys: new Set(), titles: new Set(), ts: 0, accountId: null, loggedIn: null, stats: null };
  let channelPage = null; // { key, name, subscribed }
  let syncing = false, syncProgress = 0;
  let lastError = '';
  let extAlive = true;
  // Riwayat unsubscribe (disinkron ke Google Drive oleh background): { [id]: { s: 'unsub'|'resub', at, title, url } }
  let unsubs = {};
  // Naik setiap daftar subscription / unsubscribe / pengaturan berubah -> hasil evaluasi kartu lama tidak dipakai lagi
  let gen = 0;

  /* ---------------- util ---------------- */
  const norm = (s) => (s || '').normalize('NFKC').replace(/[\u200b-\u200f\u2060\ufeff]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /** Ubah pesan error teknis menjadi kalimat yang mudah dipahami. */
  const friendlyError = (e) => {
    const m = String(e?.message || e || '');
    return /InnerTube|HTTP|fetch|network/i.test(m) ? 'Gagal terhubung ke YouTube. Periksa koneksi internet, lalu coba lagi.' : m;
  };
  const handleKey = (h) => h.toLowerCase().replace(/^(?!@)/, '@');
  /** Perubahan di dalam pemutar video (jam, bilah progres) tidak memengaruhi kartu -> tidak perlu memindai ulang. */
  const inPlayer = (n) => !!n.closest?.('.html5-video-player');

  /** Kunci channel dari URL: channelId, @handle, atau c/… / user/… */
  function keyFromPath(p) {
    if (!p) return null;
    try { if (/^https?:/i.test(p)) p = new URL(p).pathname; } catch { /* */ }
    try { p = decodeURIComponent(p); } catch { /* */ }
    let m = p.match(/^\/(@[^/?#]+)/);
    if (m) return m[1].toLowerCase();
    m = p.match(/^\/channel\/(UC[\w-]{10,})/);
    if (m) return m[1];
    m = p.match(/^\/(c|user)\/([^/?#]+)/);
    return m ? (m[1] + '/' + m[2]).toLowerCase() : null;
  }

  function safe(fn) {
    return (...a) => {
      try { return fn(...a); } catch (e) {
        if (String(e?.message).includes('Extension context invalidated')) extAlive = false;
      }
    };
  }
  function debounce(fn, ms) {
    let t = 0;
    return () => { clearTimeout(t); t = setTimeout(safe(fn), ms); };
  }

  /* ---------------- komunikasi ke main world ---------------- */
  const pending = new Map();
  let reqSeq = 0;
  function request(type, timeout = 180000, extra = {}) {
    return new Promise((resolve, reject) => {
      const reqId = ++reqSeq;
      const t = setTimeout(() => { pending.delete(reqId); reject(new Error('YouTube tidak merespons. Coba lagi sebentar lagi.')); }, timeout);
      pending.set(reqId, { resolve, reject, t });
      window.postMessage({ source: IN, type, reqId, ...extra }, location.origin);
    });
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== OUT) return;
    const { type, payload = {} } = e.data;
    const p = payload.reqId && pending.get(payload.reqId);
    if (p) {
      pending.delete(payload.reqId);
      clearTimeout(p.t);
      if (type === 'subsError') p.reject(new Error(payload.error)); else p.resolve(payload);
    } else if (type === 'syncProgress') {
      syncProgress = payload.count || 0;
    } else if (type === 'subChange') {
      payload.ids.forEach((id) => updateSub(id, payload.subscribed));
    } else if (type === 'subState') {
      updateSub(payload.id, payload.subscribed);
    }
  });

  /* ---------------- data subscription ---------------- */
  function loadSubs(data) {
    subs.list = Array.isArray(data?.list) ? data.list : [];
    subs.ts = data?.ts || 0;
    subs.accountId = data?.accountId ?? null;
    subs.stats = data?.stats || null;
    rebuildSets();
  }
  function rebuildSets() {
    gen++;
    subs.ids = new Set(); subs.keys = new Set(); subs.titles = new Set();
    for (const c of subs.list) {
      if (c.id) subs.ids.add(c.id);
      const k = keyFromPath(c.url); if (k) subs.keys.add(k);
      if (c.handle) subs.keys.add(handleKey(c.handle));
      if (c.title) subs.titles.add(norm(c.title));
    }
  }
  const persistSubs = debounce(() => {
    chrome.storage.local.set({ ytucSubs: { list: subs.list, ts: subs.ts, accountId: subs.accountId, stats: subs.stats } });
  }, 500);

  const isSubKey = (k) => (k.startsWith('UC') ? subs.ids : subs.keys).has(k);

  /** Tambah / hapus satu channel dari daftar tersimpan. */
  function setSubscribed(id, subscribed, info) {
    if (!subs.ts || subs.ids.has(id) === subscribed) return false;
    if (subscribed) {
      info ||= [...document.querySelectorAll('[data-ytuc-state]')].map((c) => c.__ytucCh).find((r) => r?.id === id);
      const url = info?.url || '';
      subs.list.push({ id, title: info?.name || info?.title || '', url, handle: url.startsWith('/@') ? url.slice(1).split('/')[0] : '' });
    } else {
      subs.list = subs.list.filter((c) => c.id !== id);
    }
    rebuildSets();
    persistSubs();
    return true;
  }

  function updateSub(id, subscribed, info) {
    if (!id) return;
    recordEvent(id, subscribed ? 'resub' : 'unsub', info);
    if (setSubscribed(id, subscribed, info)) scheduleScan(true);
  }

  /* ---------------- daftar channel yang di-unsubscribe ---------------- */
  const isLeft = (id) => unsubs[id]?.s === 'unsub' && !subs.ids.has(id);
  const saveUnsubs = debounce(() => chrome.storage.local.set({ ytucUnsubs: unsubs }), 600);

  /** Catat unsubscribe, atau hapus dari daftar bila di-subscribe lagi. */
  function recordEvent(id, s, info) {
    if (!/^UC[\w-]{10,}$/.test(id || '')) return;
    const cur = unsubs[id];
    if (cur?.s === s || (s === 'resub' && !cur)) return;
    const known = subs.list.find((c) => c.id === id); // nama & link dari daftar subscription
    unsubs[id] = { s, at: Date.now(), title: info?.name || info?.title || cur?.title || known?.title || '', url: info?.url || cur?.url || known?.url || '' };
    gen++;
    saveUnsubs();
  }

  /** Samakan daftar subscription dengan kejadian yang lebih baru (mis. dari perangkat lain lewat Google Drive). */
  function reconcile() {
    if (!subs.ts) return;
    let changed = false;
    for (const [id, e] of Object.entries(unsubs)) {
      if (e.at <= subs.ts) continue;
      const want = e.s === 'resub';
      if (subs.ids.has(id) !== want) changed = setSubscribed(id, want, e) || changed;
    }
    if (changed) scheduleScan(true);
  }

  /* ---------------- subscribe langsung dari ekstensi ---------------- */
  const busy = new Set(); // kunci channel yang sedang diproses

  /**
   * Subscribe / unsubscribe channel dari kartu. ch = { key, id, name, url, collab?, subCollab? }.
   * Video kolaborasi: subscribe semua kolaborator yang belum, unsubscribe semua kolaborator yang sudah di-subscribe.
   */
  async function changeSub(ch, action = 'subscribe') {
    const k = ch.key || ch.id || ch.url;
    if (!k || busy.has(k)) return false;
    const sub = action === 'subscribe';
    const group = sub ? ch.collab : ch.subCollab;
    const targets = group?.length ? group : [ch];
    busy.add(k);
    refreshButtons();
    try {
      const r = await request('subscription', 60000, { action, ids: targets.map((c) => c.id).filter(Boolean), url: ch.url, vid: ch.vid || '', name: ch.name || '' });
      const names = [];
      for (const id of r.ids || []) {
        const info = targets.find((c) => c.id === id) || (targets.length === 1 ? targets[0] : null) || { name: '', url: '' };
        updateSub(id, sub, info);
        names.push(info.name || id);
      }
      if (names.length) lockKey = k; // cegah klik ganda: tombol baru (+/−) tidak langsung muncul di bawah kursor
      safe(scan)();
      const missed = targets.length - names.length;
      toast((sub ? '✅ Anda sekarang subscribe' : '✅ Anda berhenti subscribe') + ` <b>${names.map(esc).join(', ')}</b>` +
        (missed > 0 ? `<br>⚠️ ${missed} channel lain gagal, coba lagi nanti.` : ''));
      return true;
    } catch (e) {
      toast(`⚠️ ${esc(friendlyError(e))}`);
      return false;
    } finally {
      busy.delete(k);
      refreshButtons();
    }
  }

  function refreshButtons() {
    for (const b of document.querySelectorAll('.ytuc-subbtn')) {
      const card = b.__ytucCard || b.closest('[data-ytuc-state]');
      const on = busy.has(card?.__ytucCh?.key);
      b.disabled = on;
      b.textContent = on ? '⏳' : b.classList.contains('ytuc-unsubbtn') ? '−' : '+';
    }
  }

  /* Pemberitahuan kecil di bawah tengah layar */
  let toastHost = null, toastTimer = 0;
  function toast(html) {
    if (!toastHost?.isConnected) {
      toastHost = document.createElement('div');
      toastHost.id = 'ytuc-toast-host';
      toastHost.attachShadow({ mode: 'open' });
      (document.body || document.documentElement).appendChild(toastHost);
    }
    toastHost.shadowRoot.innerHTML = `<style>
      .t{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;background:#212121;color:#fff;
         font:14px/1.5 Roboto,Arial,sans-serif;padding:12px 18px;border-radius:10px;box-shadow:0 6px 24px #000a;max-width:90vw}
    </style><div class="t">${html}</div>`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastHost.shadowRoot.innerHTML = ''; }, 5000);
  }

  async function doSync() {
    if (syncing) return;
    syncing = true; syncProgress = 0; lastError = '';
    const startedAt = Date.now();
    try {
      // Satu-satunya sumber: youtube.com/feed/channels (semua halaman)
      const r = await request('sync', 20 * 60e3);
      subs.loggedIn = r.loggedIn;
      if (!r.loggedIn) return;
      const list = r.list || [];

      // Pengaman: sinkron kosong TIDAK boleh menghapus daftar lama
      if (!list.length && subs.list.length) {
        lastError = 'Gagal memperbarui daftar. Daftar lama tetap dipakai, coba lagi nanti.';
        return;
      }

      // Unsubscribe / subscribe di perangkat lain: bandingkan dengan daftar sebelumnya
      const okStatus = (st) => st?.status === 'complete' || st?.status === 'merged';
      const now = new Set(list.map((c) => c.id));
      if (okStatus(subs.stats) && okStatus(r.stats) && subs.accountId === r.accountId && subs.list.length) {
        const gone = subs.list.filter((c) => c.id && !now.has(c.id));
        // Pengaman: bila terlalu banyak yang hilang sekaligus, kemungkinan gangguan dari YouTube -> jangan dicatat
        if (gone.length <= Math.max(20, subs.list.length * 0.25)) gone.forEach((c) => recordEvent(c.id, 'unsub', c));
      }
      for (const c of list) if (unsubs[c.id]?.s === 'unsub' && unsubs[c.id].at < startedAt) recordEvent(c.id, 'resub', c);

      const data = { list, ts: startedAt, accountId: r.accountId, stats: r.stats };
      loadSubs(data);
      await chrome.storage.local.set({ ytucSubs: data });
      lastError = !list.length ? 'Anda belum subscribe channel apa pun.' : r.stats?.note || '';
    } catch (e) {
      lastError = friendlyError(e);
    } finally {
      syncing = false;
      scheduleScan(true);
    }
  }

  /* ---------------- evaluasi & penandaan kartu ---------------- */
  function videoIdOfCard(card) {
    const v = card.getAttribute('data-ytuc-vid');
    if (v) return v;
    const href = card.querySelector('a[href*="watch?v="], a[href^="/shorts/"]')?.getAttribute('href') || '';
    return href.match(/[?&]v=([\w-]{11})/)?.[1] || href.match(/\/shorts\/([\w-]{11})/)?.[1] || '';
  }

  /** Kunci untuk mendeteksi video ganda: ID playlist (kartu playlist / Mix) atau ID video. */
  function dupKey(card) {
    const list = card.querySelector('a[href*="list="]')?.getAttribute('href').match(/[?&]list=([\w-]+)/)?.[1];
    return list ? 'list:' + list : videoIdOfCard(card);
  }

  function evaluate(card) {
    if (card.getAttribute('data-ytuc-ad') === '1') return null;
    let collab = null;
    try { collab = JSON.parse(card.getAttribute('data-ytuc-collab') || 'null'); } catch { /* */ }
    if (collab?.length > 1) {
      // Video kolaborasi: dianggap sudah subscribe hanya bila SEMUA kolaborator sudah di-subscribe
      const missing = collab.filter((c) => !isSubKey(c.id));
      const first = missing[0] || collab[0];
      return {
        subscribed: !missing.length,
        left: missing.length > 0 && missing.every((c) => isLeft(c.id)),
        key: missing.map((c) => c.id).join('+') || first.id,
        id: first.id,
        name: (missing.length ? missing : collab).map((c) => c.name).filter(Boolean).join(', ') || first.id,
        url: first.url || '/channel/' + first.id,
        collab: missing.filter((c) => !isLeft(c.id)),
        subCollab: missing.length ? [] : collab.filter((c) => isSubKey(c.id)) // untuk tombol unsubscribe
      };
    }
    const id = card.getAttribute('data-ytuc-cid') || '';
    let url = card.getAttribute('data-ytuc-url') || '';
    let name = card.getAttribute('data-ytuc-name') || '';
    const keys = id ? [id] : [];
    const uk = keyFromPath(url); if (uk && uk !== id) keys.push(uk);

    if (!keys.length) {
      const a = card.querySelector(CHANNEL_LINK);
      const k = a && keyFromPath(a.getAttribute('href'));
      if (k) { keys.push(k); url ||= a.getAttribute('href'); name ||= a.textContent.trim(); }
    }
    if (!name) name = card.querySelector(NAME_SEL)?.textContent.trim() || '';
    if (!keys.length && !name) return null;

    const subscribed = keys.some(isSubKey) || (!!name && subs.titles.has(norm(name)));
    // ID channel: dari kartu, atau (untuk channel yang sudah di-subscribe) dari daftar subscription
    const cid = id || keys.find((k) => k.startsWith('UC')) || (subscribed ? idFromList(keys, name) : leftIdFromKeys(keys)) || '';
    return {
      subscribed,
      left: !subscribed && isLeft(cid),
      key: keys[0] || 'name:' + norm(name),
      id: cid,
      name: name || keys[0],
      url: url || (id ? '/channel/' + id : '')
    };
  }

  /** Cari ID channel yang sudah di-subscribe dari daftar subscription (lewat @handle / link / nama). */
  function idFromList(keys, name) {
    const n = norm(name);
    const hit = subs.list.find((c) => keys.some((k) => k === keyFromPath(c.url) || (c.handle && k === handleKey(c.handle)))) ||
      (n ? subs.list.find((c) => norm(c.title) === n) : null);
    return hit?.id || '';
  }

  /** ID channel di daftar unsubscribe yang link-nya cocok (kartu yang hanya membawa @handle). */
  function leftIdFromKeys(keys) {
    if (!keys.length) return '';
    for (const [id, e] of Object.entries(unsubs)) if (e.s === 'unsub' && e.url && keys.includes(keyFromPath(e.url))) return id;
    return '';
  }

  /**
   * Tombol di pojok kiri atas thumbnail:
   *  kind 'sub'   -> "+" (subscribe), untuk channel yang belum di-subscribe
   *  kind 'unsub' -> "−" biru (unsubscribe), untuk channel yang sudah di-subscribe (muncul saat kursor di atas video)
   */
  const BTN = {
    sub: { cls: 'ytuc-subbtn', text: '+', label: 'Subscribe channel ini' },
    unsub: { cls: 'ytuc-subbtn ytuc-unsubbtn', text: '−', label: 'Unsubscribe channel ini' }
  };
  /** Halaman video & kartu channel: YouTube sudah punya tombol Subscribe sendiri. */
  const buttonAllowed = (card) => settings.showSubButton && !card.matches('ytd-video-owner-renderer') && !card.querySelector('ytd-subscribe-button-renderer');

  /** Tombol baru. getCard() = kartu yang sedang dilayani tombol ini. */
  function makeButton(getCard) {
    const btn = document.createElement('button');
    btn.type = 'button';
    // Jangan sampai klik tombol ikut membuka video
    for (const ev of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend']) btn.addEventListener(ev, (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      const ch = getCard()?.__ytucCh;
      if (ch && !btn.disabled) changeSub({ ...ch }, btn.__ytucKind === 'unsub' ? 'unsubscribe' : 'subscribe');
    });
    return btn;
  }

  /** Atur tampilan tombol sesuai jenisnya ('sub' = +, 'unsub' = −). */
  function setKind(btn, kind, card, extraCls = '') {
    if (btn.__ytucKind === kind && btn.__ytucCard === card) return;
    const d = BTN[kind];
    btn.__ytucKind = kind;
    btn.__ytucCard = card;
    btn.className = d.cls + extraCls;
    btn.title = d.label;
    btn.setAttribute('aria-label', d.label);
    const on = busy.has(card.__ytucCh?.key);
    btn.disabled = on;
    btn.textContent = on ? '⏳' : d.text;
  }

  /** Tombol "+" yang menempel di kartu (selalu tampil). Tombol "−" memakai tombol melayang (lihat updateHover). */
  function placeButton(card, kind) {
    let btn = card.__ytucBtn;
    if (kind !== 'sub') {
      if (btn) { btn.remove(); card.__ytucBtn = null; }
      return;
    }
    btn ||= card.__ytucBtn = makeButton(() => card);
    setKind(btn, kind, card);
    if (btn.isConnected && card.contains(btn)) return;
    const host = card.querySelector(THUMB_SEL) || card.firstElementChild || card;
    host.classList.add('ytuc-host');
    host.appendChild(btn);
  }

  function clearCard(card) {
    if (card.hasAttribute('data-ytuc-state')) card.removeAttribute('data-ytuc-state');
    if (card.hasAttribute('data-ytuc-dup')) card.removeAttribute('data-ytuc-dup');
    card.__ytucKind = null;
    card.__ytucSig = '';
    placeButton(card, null);
  }

  /* ---------------- tombol melayang saat kursor di atas video ----------------
   * Saat pratinjau video berjalan, YouTube menaruh pemutar pratinjau (ytd-video-preview) DI ATAS kartu,
   * di luar elemen kartu. Akibatnya :hover pada kartu hilang-timbul. Karena itu kartu yang sedang ditunjuk
   * dicari dari posisi kursor (elementsFromPoint), dan tombolnya digambar melayang di atas pratinjau.
   */
  const PREVIEW_SEL = 'ytd-video-preview, #video-preview, #inline-preview-player';
  let pointer = null, hoverCard = null, floatBtn = null, hoverQueued = false, masthead = null;
  let lockKey = null; // kartu yang baru saja di-subscribe/unsubscribe: tombol disembunyikan sampai kursor pindah

  const outerCard = (el) => {
    for (let c = el?.closest?.('[data-ytuc-state]'); c; c = c.parentElement?.closest('[data-ytuc-state]')) {
      if (!c.parentElement?.closest('[data-ytuc-state]')) return c;
    }
    return null;
  };

  function getFloatBtn() {
    if (floatBtn?.isConnected) return floatBtn;
    floatBtn = makeButton(() => floatBtn.__ytucCard);
    floatBtn.hidden = true;
    (document.body || document.documentElement).appendChild(floatBtn);
    return floatBtn;
  }
  /** Bawah bilah atas YouTube (tombol tidak boleh menutupinya). */
  function headerBottom() {
    if (!masthead?.isConnected) masthead = document.querySelector('#masthead-container, ytd-masthead');
    return masthead?.getBoundingClientRect().bottom || 0;
  }

  function setHoverCard(card) {
    if (hoverCard === card) return;
    hoverCard?.removeAttribute('data-ytuc-hover');
    hoverCard = card;
    card?.setAttribute('data-ytuc-hover', '');
  }

  function hideFloat() {
    setHoverCard(null);
    if (floatBtn && !floatBtn.hidden) floatBtn.hidden = true;
  }

  function leave() { lockKey = null; hideFloat(); } // kursor tidak di atas video mana pun

  function updateHover() {
    hoverQueued = false;
    if (!pointer || !document.documentElement.classList.contains('ytuc-on')) return leave();
    const top = document.elementFromPoint(pointer.x, pointer.y);
    if (!top) return leave();
    let card;
    if (top === floatBtn) card = hoverCard; // kursor di atas tombol itu sendiri
    else {
      card = outerCard(top);
      if (!card) {
        // Kursor di atas pemutar pratinjau: cari kartu di bawahnya; bila pratinjau lebih lebar dari kartu, pertahankan kartu terakhir
        if (!top.closest(PREVIEW_SEL)) return leave();
        card = document.elementsFromPoint(pointer.x, pointer.y).map(outerCard).find(Boolean) || (hoverCard?.isConnected ? hoverCard : null);
      }
    }
    const key = card?.__ytucCh?.key;
    if (lockKey && key !== lockKey) lockKey = null;
    const kind = card?.__ytucKind;
    if (!card || !kind || !card.isConnected || (lockKey && key === lockKey)) return hideFloat();
    const host = card.querySelector(THUMB_SEL) || card.firstElementChild || card;
    const r = host.getBoundingClientRect();
    if (!r.width || r.top + 8 < headerBottom()) return hideFloat();
    setHoverCard(card);
    const b = getFloatBtn();
    setKind(b, kind, card, ' ytuc-float');
    b.style.left = Math.round(r.left + 8) + 'px';
    b.style.top = Math.round(r.top + 8) + 'px';
    if (b.hidden) b.hidden = false;
  }

  function queueHover() {
    if (!hoverQueued) { hoverQueued = true; requestAnimationFrame(safe(updateHover)); }
  }
  function onPointer(e) {
    if (e.pointerType === 'touch') return; // layar sentuh: tidak ada kursor
    pointer = { x: e.clientX, y: e.clientY };
    queueHover();
  }

  function scan() {
    const ready = settings.enabled && subs.loggedIn !== false && subs.ts > 0;
    document.documentElement.classList.toggle('ytuc-on', ready);
    // Satu kali telusur DOM (halaman YouTube bisa berisi puluhan ribu elemen): grid & jumlah video ikut dihitung di sini
    const grids = new Set();
    // Jumlah video untuk muat otomatis: hanya halaman yang sedang tampil (YouTube menyimpan halaman sebelumnya, tersembunyi)
    const page = document.querySelector('ytd-page-manager > :not([hidden])');
    let marked = 0;
    // Video ganda (bersama fitur urutan): kemunculan pertama di daftar dipertahankan, sisanya disembunyikan
    const dedupe = ready && !!settings.sortUnsub;
    const seen = new Set();
    const done = (card, parent) => {
      const shown = !page || page.contains(card);
      const key = dedupe && shown && isList(parent) && card.__ytucKey;
      const dup = !!key && seen.has(key);
      if (key) seen.add(key);
      if (card.hasAttribute('data-ytuc-dup') !== dup) card.toggleAttribute('data-ytuc-dup', dup);
      if (shown && !dup) marked++;
      placeButton(card, card.__ytucKind);
    };

    for (const card of document.querySelectorAll(CARD_SEL)) {
      const parent = card.parentElement;
      if (card.localName === 'ytd-rich-item-renderer' && parent?.id === 'contents' && parent.parentElement?.localName === 'ytd-rich-grid-renderer') grids.add(parent);
      // Data kartu (data-ytuc-v dari main-world.js) dan daftar tidak berubah -> hasil lama masih benar
      const sig = ready ? gen + '|' + card.getAttribute('data-ytuc-v') : '';
      if (sig && card.__ytucSig === sig) { done(card, parent); continue; }
      // Hanya kartu paling luar (hindari tanda ganda pada elemen bersarang)
      const r = ready && !parent?.closest(CARD_SEL) ? evaluate(card) : null;
      if (!r) { clearCard(card); continue; }
      // sub = sudah subscribe · left = ada di daftar unsubscribe (bingkai kuning, tanpa tombol +) · unsub = belum
      const state = r.subscribed ? 'sub' : r.left ? 'left' : 'unsub';
      if (card.getAttribute('data-ytuc-state') !== state) card.setAttribute('data-ytuc-state', state);
      if (!r.id) r.vid = videoIdOfCard(card); // cadangan untuk mencari ID channel saat tombol + diklik
      card.__ytucCh = r;
      card.__ytucKey = dupKey(card);
      // Tombol unsubscribe hanya bila ID channel pasti ada di daftar subscription (hindari salah channel karena nama sama)
      const canUnsub = state === 'sub' && (r.subCollab ? r.subCollab.length > 0 : subs.ids.has(r.id));
      const kind = state === 'unsub' ? 'sub' : canUnsub ? 'unsub' : null;
      card.__ytucKind = kind && buttonAllowed(card) ? kind : null;
      // Hanya kartu yang ID channel-nya pasti yang disimpan; sisanya (dari teks halaman) dicek ulang tiap kali
      card.__ytucSig = r.id ? sig : '';
      done(card, parent);
    }

    fixGridColumns(grids, ready && !!settings.sortUnsub);
    updateAutoload(ready, marked);
    queueHover(); // isi halaman berubah di bawah kursor

    // Halaman channel yang sedang dibuka
    channelPage = null;
    const pk = keyFromPath(location.pathname);
    if (ready && pk) {
      const nm = document.querySelector('yt-page-header-renderer h1, #page-header h1, ytd-c4-tabbed-header-renderer #text')?.textContent?.trim() || pk;
      channelPage = { key: pk, name: nm, subscribed: isSubKey(pk) || subs.titles.has(norm(nm)) };
    }
  }

  /* ---------------- urutan: belum di-subscribe di paling atas ---------------- */
  // Urutan diatur lewat CSS `order` (lihat content.css) sehingga elemen YouTube tidak dipindah.
  // Khusus grid (Beranda, tab Video channel): tandai ulang kolom pertama tiap baris agar jarak kiri tetap rapi.
  // Daftar video yang diurutkan & dibersihkan dari video ganda (sama dengan content.css)
  const LIST_SEL = 'ytd-rich-grid-renderer > #contents, ytd-search ytd-item-section-renderer > #contents, #related ytd-item-section-renderer > #contents';
  const isList = (el) => !!el && (el.__ytucList ??= el.matches(LIST_SEL));
  const SORT_RANK = { unsub: -1, sub: 0, left: 1 };
  function sortRank(el) {
    if (el.localName === 'ytd-continuation-item-renderer') return 99;
    if (el.hasAttribute('data-ytuc-dup')) return 100; // disembunyikan: kolom grid sesudahnya ikut bergeser
    return SORT_RANK[el.getAttribute('data-ytuc-state')] || 0;
  }
  function fixGridColumns(grids, active) {
    for (const grid of grids) {
      const kids = [...grid.children];
      const ranks = active ? kids.map(sortRank) : [];
      const sig = active ? gen + '|' + getComputedStyle(grid).getPropertyValue('--ytd-rich-grid-items-per-row') + '|' + ranks.join(',') : '';
      if (grid.__ytucSortSig === sig) continue;
      grid.__ytucSortSig = sig;
      const sorted = ranks.map((r, i) => ({ el: kids[i], i, r })).sort((a, b) => a.r - b.r || a.i - b.i);
      if (!active || sorted.every((x, i) => x.i === i)) { // tidak ada yang berpindah -> biarkan YouTube yang mengatur
        for (const el of kids) if (el.hasAttribute('data-ytuc-col')) el.removeAttribute('data-ytuc-col');
        continue;
      }
      const perRowCache = {};
      let col = 0;
      for (const { el } of sorted) {
        const visible = el.getClientRects().length > 0;
        if (el.localName !== 'ytd-rich-item-renderer') { if (visible) col = 0; continue; } // bagian selebar layar -> baris baru
        if (!visible) { el.removeAttribute('data-ytuc-col'); continue; }
        const v = el.hasAttribute('is-slim-media') ? '--ytd-rich-grid-slim-items-per-row'
          : el.hasAttribute('is-post') ? '--ytd-rich-grid-posts-per-row' : '--ytd-rich-grid-items-per-row';
        const per = perRowCache[v] ??= (parseInt(getComputedStyle(el).getPropertyValue(v), 10) || parseInt(el.getAttribute('items-per-row'), 10) || 3);
        const val = col % per === 0 ? 'first' : 'rest';
        col++;
        if (el.getAttribute('data-ytuc-col') !== val) el.setAttribute('data-ytuc-col', val);
      }
    }
  }

  /* ---------------- muat otomatis sebelum diurutkan ----------------
   * YouTube memuat video berikutnya saat elemen "muat lagi" (ytd-continuation-item-renderer) terlihat di layar.
   * Selama kelas ytuc-autoload aktif, elemen itu dibuat tak terlihat tetapi selalu "di layar" (lihat content.css),
   * sehingga YouTube terus memuat tanpa halaman digulir. Berhenti di AUTOLOAD.limit video (n = kartu yang ditandai),
   * atau bila tidak ada tambahan selama AUTOLOAD.stallMs (daftar habis / YouTube berhenti). Setelah itu gulir biasa berlaku lagi.
   */
  const AUTOLOAD_PATH = /^\/(results|watch)?$/; // Beranda, Pencarian, halaman tonton
  let auto = { page: '', count: -1, since: 0, done: false };

  function updateAutoload(ready, n) {
    const page = location.pathname + location.search;
    if (auto.page !== page) auto = { page, count: -1, since: 0, done: false }; // halaman baru -> mulai lagi
    let on = false;
    if (ready && settings.sortUnsub && !auto.done && AUTOLOAD_PATH.test(location.pathname)) {
      if (n !== auto.count) { auto.count = n; auto.since = Date.now(); }
      auto.done = n >= AUTOLOAD.limit || Date.now() - auto.since > AUTOLOAD.stallMs;
      on = !auto.done;
    }
    document.documentElement.classList.toggle('ytuc-autoload', on);
  }

  let scanTimer = 0;
  function scheduleScan(rescanMain) {
    if (rescanMain) window.postMessage({ source: IN, type: 'rescan' }, location.origin);
    if (!scanTimer) scanTimer = setTimeout(() => { scanTimer = 0; safe(scan)(); }, 300);
  }

  function applySettings() {
    gen++;
    const cl = document.documentElement.classList;
    for (const c of [...cl]) if (c.startsWith('ytuc-mode-')) cl.remove(c);
    cl.add('ytuc-mode-' + settings.mode);
    cl.toggle('ytuc-sort', !!settings.sortUnsub);
    document.documentElement.style.setProperty('--ytuc-color', settings.color);
    document.documentElement.style.setProperty('--ytuc-left', settings.leftColor);
    scheduleScan();
  }

  /* ---------------- popup / storage ---------------- */
  const state = () => ({
    loggedIn: subs.loggedIn, subsCount: subs.list.length, ts: subs.ts, stats: subs.stats,
    syncing, syncProgress, lastError, channelPage
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'getState') { sendResponse(state()); return; }
    if (msg?.type === 'sync') { doSync().then(() => { scan(); sendResponse(state()); }); return true; }
  });

  chrome.storage.onChanged.addListener(safe((changes, area) => {
    if (area === 'sync' && changes.ytucSettings) {
      settings = { ...DEFAULTS, ...changes.ytucSettings.newValue };
      applySettings();
    }
    if (area !== 'local') return;
    if (changes.ytucSubs && !syncing) { loadSubs(changes.ytucSubs.newValue); reconcile(); scheduleScan(); }
    if (changes.ytucUnsubs) {
      // Gabungkan (kejadian terbaru menang) agar catatan yang belum sempat disimpan tidak tertimpa
      const inc = changes.ytucUnsubs.newValue || {};
      const merged = { ...inc };
      for (const [id, e] of Object.entries(unsubs)) if (!merged[id] || e.at > merged[id].at) merged[id] = e;
      unsubs = merged;
      gen++;
      reconcile(); scheduleScan();
    }
  }));

  /* ---------------- init ---------------- */
  async function init() {
    const [{ ytucSettings }, { ytucSubs, ytucUnsubs }] = await Promise.all([
      chrome.storage.sync.get('ytucSettings'), chrome.storage.local.get(['ytucSubs', 'ytucUnsubs'])
    ]);
    unsubs = ytucUnsubs || {};
    safe(() => chrome.runtime.sendMessage({ type: 'drivePull' }).catch(() => {}))(); // ambil perubahan dari perangkat lain
    settings = { ...DEFAULTS, ...ytucSettings };
    loadSubs(ytucSubs);
    reconcile();
    applySettings();

    new MutationObserver((muts) => {
      if (muts.some((m) => (m.type === 'attributes' || m.addedNodes.length) && !inPlayer(m.target))) scheduleScan();
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-ytuc-v', 'hidden'] });
    // Cadangan tiap 10 detik; selama muat otomatis tiap 2,5 detik (untuk mendeteksi daftar yang sudah habis)
    let tick = 0;
    setInterval(() => extAlive && (++tick % 4 === 0 || document.documentElement.classList.contains('ytuc-autoload')) && scheduleScan(), 2500);
    for (const ev of ['pointermove', 'pointerover']) document.addEventListener(ev, onPointer, { capture: true, passive: true });
    document.addEventListener('scroll', queueHover, { capture: true, passive: true });
    window.addEventListener('resize', queueHover, { passive: true });
    document.documentElement.addEventListener('mouseleave', () => { pointer = null; leave(); });
    window.addEventListener('blur', () => { pointer = null; leave(); });
    document.addEventListener('yt-navigate-finish', () => scheduleScan(true));

    let hello;
    try { hello = await request('hello', 30000); } catch { hello = { loggedIn: null }; }
    subs.loggedIn = hello.loggedIn;
    gen++;
    if (hello.loggedIn === false) { scheduleScan(); return; }

    const stale = Date.now() - subs.ts > settings.autoSyncHours * 3600e3;
    const otherAccount = hello.accountId && subs.accountId && hello.accountId !== subs.accountId;
    const oldFormat = subs.ts && !subs.stats?.status; // data versi lama -> perbarui sekali
    if (stale || otherAccount || oldFormat || !subs.list.length) await doSync();
    else scheduleScan();
  }
  init().catch((e) => { lastError = friendlyError(e); });
})();
