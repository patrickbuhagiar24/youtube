/*
 * Content script (isolated world).
 * Stores subscriptions, marks cards,
 * and communicates with main-world.js, the popup, and the background worker.
 */
(() => {
  'use strict';
  if (window.__YOUSUB_CONTENT__) return;
  window.__YOUSUB_CONTENT__ = true;

  const IN = 'yousub-content';
  const OUT = 'yousub-main';
  const { DEFAULTS, CARD_SEL, AUTOLOAD } = YOUSUB;
  const THUMB_SEL = 'ytd-thumbnail, #thumbnail, yt-thumbnail-view-model, .yt-lockup-view-model__content-image, ' +
    '[class*="lockup-view-model"][class*="content-image"], [class*="LockupViewModelContentImage"], #avatar-section, #avatar, ytd-playlist-thumbnail';
  // Old (kebab-case) and new (camelCase, e.g. ytContentMetadataViewModelMetadataRow) class names
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
  // Unsubscribe history (synced to Google Drive by the background worker): { [id]: { s: 'unsub'|'resub', at, title, url } }
  let unsubs = {};
  // Increment when subscriptions, unsubscribe history, or settings change to invalidate cached card evaluations
  let gen = 0;

  /* ---------------- util ---------------- */
  const norm = (s) => (s || '').normalize('NFKC').replace(/[\u200b-\u200f\u2060\ufeff]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /** Turn technical errors into a readable message. */
  const friendlyError = (e) => {
    const m = String(e?.message || e || '');
    return /InnerTube|HTTP|fetch|network/i.test(m) ? 'Could not connect to YouTube. Check your internet connection and try again.' : m;
  };
  const handleKey = (h) => h.toLowerCase().replace(/^(?!@)/, '@');
  /** Changes inside the player (time, progress bar) do not affect cards, so skip rescanning them. */
  const inPlayer = (n) => !!n.closest?.('.html5-video-player');

  /** Channel key from a URL: channelId, @handle, or c/... / user/... */
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

  /* ---------------- communication with the main world ---------------- */
  const pending = new Map();
  let reqSeq = 0;
  function request(type, timeout = 180000, extra = {}) {
    return new Promise((resolve, reject) => {
      const reqId = ++reqSeq;
      const t = setTimeout(() => { pending.delete(reqId); reject(new Error('YouTube did not respond. Please try again shortly.')); }, timeout);
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
    chrome.storage.local.set({ yousubSubs: { list: subs.list, ts: subs.ts, accountId: subs.accountId, stats: subs.stats } });
  }, 500);

  const isSubKey = (k) => (k.startsWith('UC') ? subs.ids : subs.keys).has(k);

  /** Add or remove one channel from the stored subscription list. */
  function setSubscribed(id, subscribed, info) {
    if (!subs.ts || subs.ids.has(id) === subscribed) return false;
    if (subscribed) {
      info ||= [...document.querySelectorAll('[data-yousub-state]')].map((c) => c.__yousubCh).find((r) => r?.id === id);
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

  /* ---------------- unsubscribe history ---------------- */
  const isLeft = (id) => unsubs[id]?.s === 'unsub' && !subs.ids.has(id);
  const saveUnsubs = debounce(() => chrome.storage.local.set({ yousubUnsubs: unsubs }), 600);

  /** Record an unsubscribe, or a resubscribe if the channel was previously left. */
  function recordEvent(id, s, info) {
    if (!/^UC[\w-]{10,}$/.test(id || '')) return;
    const cur = unsubs[id];
    if (cur?.s === s || (s === 'resub' && !cur)) return;
    const known = subs.list.find((c) => c.id === id); // Name and URL from the subscription list
    unsubs[id] = { s, at: Date.now(), title: info?.name || info?.title || cur?.title || known?.title || '', url: info?.url || cur?.url || known?.url || '' };
    gen++;
    saveUnsubs();
  }

  /** Reconcile subscriptions with newer events, such as changes from another device via Google Drive. */
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

  /* ---------------- subscribe directly from the extension ---------------- */
  const busy = new Set(); // Channel keys currently being processed

  /**
   * Subscribe or unsubscribe from a card. ch = { key, id, name, url, collab?, subCollab? }.
   * Collaborations: subscribe to all missing collaborators, or unsubscribe from all subscribed collaborators.
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
      if (names.length) lockKey = k; // Prevent double clicks: do not immediately show the new button under the cursor
      safe(scan)();
      const missed = targets.length - names.length;
      toast((sub ? '✅ You are now subscribed to' : '✅ You unsubscribed from') + ` <b>${names.map(esc).join(', ')}</b>` +
        (missed > 0 ? `<br>⚠️ ${missed} other channel(s) failed. Try again later.` : ''));
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
    for (const b of document.querySelectorAll('.yousub-subbtn')) {
      const card = b.__yousubCard || b.closest('[data-yousub-state]');
      const on = busy.has(card?.__yousubCh?.key);
      b.disabled = on;
      b.textContent = on ? '⏳' : b.classList.contains('yousub-unsubbtn') ? '−' : '+';
    }
  }

  /* Small notification at the bottom center of the screen */
  let toastHost = null, toastTimer = 0;
  function toast(html) {
    if (!toastHost?.isConnected) {
      toastHost = document.createElement('div');
      toastHost.id = 'yousub-toast-host';
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
      // The only source: youtube.com/feed/channels (all pages)
      const r = await request('sync', 20 * 60e3);
      subs.loggedIn = r.loggedIn;
      if (!r.loggedIn) return;
      const list = r.list || [];

      // Safety guard: an empty sync must NOT erase the existing list
      if (!list.length && subs.list.length) {
        lastError = 'Could not refresh the list. Keeping the existing list; try again later.';
        return;
      }

      // Detect unsubscribes or resubscribes on other devices by comparing with the previous list
      const okStatus = (st) => st?.status === 'complete' || st?.status === 'merged';
      const now = new Set(list.map((c) => c.id));
      if (okStatus(subs.stats) && okStatus(r.stats) && subs.accountId === r.accountId && subs.list.length) {
        const gone = subs.list.filter((c) => c.id && !now.has(c.id));
        // Safety guard: too many missing channels at once may be a YouTube outage; do not record them
        if (gone.length <= Math.max(20, subs.list.length * 0.25)) gone.forEach((c) => recordEvent(c.id, 'unsub', c));
      }
      for (const c of list) if (unsubs[c.id]?.s === 'unsub' && unsubs[c.id].at < startedAt) recordEvent(c.id, 'resub', c);

      const data = { list, ts: startedAt, accountId: r.accountId, stats: r.stats };
      loadSubs(data);
      await chrome.storage.local.set({ yousubSubs: data });
      lastError = !list.length ? 'You are not subscribed to any channels.' : r.stats?.note || '';
    } catch (e) {
      lastError = friendlyError(e);
    } finally {
      syncing = false;
      scheduleScan(true);
    }
  }

  /* ---------------- card evaluation and marking ---------------- */
  function videoIdOfCard(card) {
    const v = card.getAttribute('data-yousub-vid');
    if (v) return v;
    const href = card.querySelector('a[href*="watch?v="], a[href^="/shorts/"]')?.getAttribute('href') || '';
    return href.match(/[?&]v=([\w-]{11})/)?.[1] || href.match(/\/shorts\/([\w-]{11})/)?.[1] || '';
  }

  /** Duplicate key: playlist ID for playlist/Mix cards, otherwise video ID. */
  function dupKey(card) {
    const list = card.querySelector('a[href*="list="]')?.getAttribute('href').match(/[?&]list=([\w-]+)/)?.[1];
    return list ? 'list:' + list : videoIdOfCard(card);
  }

  function evaluate(card) {
    if (card.getAttribute('data-yousub-ad') === '1') return null;
    let collab = null;
    try { collab = JSON.parse(card.getAttribute('data-yousub-collab') || 'null'); } catch { /* */ }
    if (collab?.length > 1) {
      // A collaboration is subscribed only when ALL collaborators are subscribed
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
        subCollab: missing.length ? [] : collab.filter((c) => isSubKey(c.id)) // For the unsubscribe button
      };
    }
    const id = card.getAttribute('data-yousub-cid') || '';
    let url = card.getAttribute('data-yousub-url') || '';
    let name = card.getAttribute('data-yousub-name') || '';
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
    // Channel ID from the card or, for subscribed channels, from the subscription list
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

  /** Find a subscribed channel ID by @handle, URL, or name in the subscription list. */
  function idFromList(keys, name) {
    const n = norm(name);
    const hit = subs.list.find((c) => keys.some((k) => k === keyFromPath(c.url) || (c.handle && k === handleKey(c.handle)))) ||
      (n ? subs.list.find((c) => norm(c.title) === n) : null);
    return hit?.id || '';
  }

  /** Find an unsubscribe-history channel ID by URL for cards that only provide an @handle. */
  function leftIdFromKeys(keys) {
    if (!keys.length) return '';
    for (const [id, e] of Object.entries(unsubs)) if (e.s === 'unsub' && e.url && keys.includes(keyFromPath(e.url))) return id;
    return '';
  }

  /**
   * Button in the top-left corner of a thumbnail:
   *  kind 'sub'   -> "+" (subscribe), for channels not yet subscribed
   *  kind 'unsub' -> blue "−" (unsubscribe), shown on hover for subscribed channels
   */
  const BTN = {
    sub: { cls: 'yousub-subbtn', text: '+', label: 'Subscribe to this channel' },
    unsub: { cls: 'yousub-subbtn yousub-unsubbtn', text: '−', label: 'Unsubscribe from this channel' }
  };
  /** Watch pages and channel cards already have their own YouTube Subscribe button. */
  const buttonAllowed = (card) => settings.showSubButton && !card.matches('ytd-video-owner-renderer') && !card.querySelector('ytd-subscribe-button-renderer');

  /** Create a button. getCard() returns the card this button currently acts on. */
  function makeButton(getCard) {
    const btn = document.createElement('button');
    btn.type = 'button';
    // Do not let a button click also open the video
    for (const ev of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend']) btn.addEventListener(ev, (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      const ch = getCard()?.__yousubCh;
      if (ch && !btn.disabled) changeSub({ ...ch }, btn.__yousubKind === 'unsub' ? 'unsubscribe' : 'subscribe');
    });
    return btn;
  }

  /** Update the button appearance for its kind ('sub' = +, 'unsub' = −). */
  function setKind(btn, kind, card, extraCls = '') {
    if (btn.__yousubKind === kind && btn.__yousubCard === card) return;
    const d = BTN[kind];
    btn.__yousubKind = kind;
    btn.__yousubCard = card;
    btn.className = d.cls + extraCls;
    btn.title = d.label;
    btn.setAttribute('aria-label', d.label);
    const on = busy.has(card.__yousubCh?.key);
    btn.disabled = on;
    btn.textContent = on ? '⏳' : d.text;
  }

  /** The "+" button is attached to the card. The "−" button floats (see updateHover). */
  function placeButton(card, kind) {
    let btn = card.__yousubBtn;
    if (kind !== 'sub') {
      if (btn) { btn.remove(); card.__yousubBtn = null; }
      return;
    }
    btn ||= card.__yousubBtn = makeButton(() => card);
    setKind(btn, kind, card);
    if (btn.isConnected && card.contains(btn)) return;
    const host = card.querySelector(THUMB_SEL) || card.firstElementChild || card;
    host.classList.add('yousub-host');
    host.appendChild(btn);
  }

  function clearCard(card) {
    if (card.hasAttribute('data-yousub-state')) card.removeAttribute('data-yousub-state');
    if (card.hasAttribute('data-yousub-dup')) card.removeAttribute('data-yousub-dup');
    card.__yousubKind = null;
    card.__yousubSig = '';
    placeButton(card, null);
  }

  /* ---------------- floating button while hovering over a video ----------------
   * During playback, YouTube places its preview player (ytd-video-preview) ABOVE the card,
   * outside the card element, making :hover flicker. Find the hovered card from the cursor
   * position (elementsFromPoint), and draw a floating button above the preview.
   */
  const PREVIEW_SEL = 'ytd-video-preview, #video-preview, #inline-preview-player';
  let pointer = null, hoverCard = null, floatBtn = null, hoverQueued = false, masthead = null;
  let lockKey = null; // Hide the button after a subscription change until the cursor moves to another card

  const outerCard = (el) => {
    for (let c = el?.closest?.('[data-yousub-state]'); c; c = c.parentElement?.closest('[data-yousub-state]')) {
      if (!c.parentElement?.closest('[data-yousub-state]')) return c;
    }
    return null;
  };

  function getFloatBtn() {
    if (floatBtn?.isConnected) return floatBtn;
    floatBtn = makeButton(() => floatBtn.__yousubCard);
    floatBtn.hidden = true;
    (document.body || document.documentElement).appendChild(floatBtn);
    return floatBtn;
  }
  /** Bottom edge of the YouTube header; the button must not cover it. */
  function headerBottom() {
    if (!masthead?.isConnected) masthead = document.querySelector('#masthead-container, ytd-masthead');
    return masthead?.getBoundingClientRect().bottom || 0;
  }

  function setHoverCard(card) {
    if (hoverCard === card) return;
    hoverCard?.removeAttribute('data-yousub-hover');
    hoverCard = card;
    card?.setAttribute('data-yousub-hover', '');
  }

  function hideFloat() {
    setHoverCard(null);
    if (floatBtn && !floatBtn.hidden) floatBtn.hidden = true;
  }

  function leave() { lockKey = null; hideFloat(); } // The cursor is not over any video

  function updateHover() {
    hoverQueued = false;
    if (!pointer || !document.documentElement.classList.contains('yousub-on')) return leave();
    const top = document.elementFromPoint(pointer.x, pointer.y);
    if (!top) return leave();
    let card;
    if (top === floatBtn) card = hoverCard; // The cursor is over the button itself
    else {
      card = outerCard(top);
      if (!card) {
        // Over a preview player: find the card beneath it; keep the last card if the preview is wider
        if (!top.closest(PREVIEW_SEL)) return leave();
        card = document.elementsFromPoint(pointer.x, pointer.y).map(outerCard).find(Boolean) || (hoverCard?.isConnected ? hoverCard : null);
      }
    }
    const key = card?.__yousubCh?.key;
    if (lockKey && key !== lockKey) lockKey = null;
    const kind = card?.__yousubKind;
    if (!card || !kind || !card.isConnected || (lockKey && key === lockKey)) return hideFloat();
    const host = card.querySelector(THUMB_SEL) || card.firstElementChild || card;
    const r = host.getBoundingClientRect();
    if (!r.width || r.top + 8 < headerBottom()) return hideFloat();
    setHoverCard(card);
    const b = getFloatBtn();
    setKind(b, kind, card, ' yousub-float');
    b.style.left = Math.round(r.left + 8) + 'px';
    b.style.top = Math.round(r.top + 8) + 'px';
    if (b.hidden) b.hidden = false;
  }

  function queueHover() {
    if (!hoverQueued) { hoverQueued = true; requestAnimationFrame(safe(updateHover)); }
  }
  function onPointer(e) {
    if (e.pointerType === 'touch') return; // Touch screens have no hover cursor
    pointer = { x: e.clientX, y: e.clientY };
    queueHover();
  }

  function scan() {
    const ready = settings.enabled && subs.loggedIn !== false && subs.ts > 0;
    document.documentElement.classList.toggle('yousub-on', ready);
    // Traverse the DOM once (YouTube may have tens of thousands of elements), also counting grids and videos
    const grids = new Set();
    // Autoload counts only the visible page; YouTube keeps previous pages hidden
    const page = document.querySelector('ytd-page-manager > :not([hidden])');
    let marked = 0;
    // Deduplicate while sorting: keep the first occurrence in each list and hide the rest
    const dedupe = ready && !!settings.sortUnsub;
    const seen = new Set();
    const done = (card, parent) => {
      const shown = !page || page.contains(card);
      const key = dedupe && shown && isList(parent) && card.__yousubKey;
      const dup = !!key && seen.has(key);
      if (key) seen.add(key);
      if (card.hasAttribute('data-yousub-dup') !== dup) card.toggleAttribute('data-yousub-dup', dup);
      if (shown && !dup) marked++;
      placeButton(card, card.__yousubKind);
    };

    for (const card of document.querySelectorAll(CARD_SEL)) {
      const parent = card.parentElement;
      if (card.localName === 'ytd-rich-item-renderer' && parent?.id === 'contents' && parent.parentElement?.localName === 'ytd-rich-grid-renderer') grids.add(parent);
      // Neither card data (data-yousub-v from main-world.js) nor subscriptions changed; reuse the result
      const sig = ready ? gen + '|' + card.getAttribute('data-yousub-v') : '';
      if (sig && card.__yousubSig === sig) { done(card, parent); continue; }
      // Only mark outermost cards to avoid duplicate marks on nested elements
      const r = ready && !parent?.closest(CARD_SEL) ? evaluate(card) : null;
      if (!r) { clearCard(card); continue; }
      // sub = subscribed; left = previously unsubscribed (yellow outline, no +); unsub = not subscribed
      const state = r.subscribed ? 'sub' : r.left ? 'left' : 'unsub';
      if (card.getAttribute('data-yousub-state') !== state) card.setAttribute('data-yousub-state', state);
      if (!r.id) r.vid = videoIdOfCard(card); // Fallback for resolving a channel ID when + is clicked
      card.__yousubCh = r;
      card.__yousubKey = dupKey(card);
      // Only offer unsubscribe for a confirmed subscribed ID, avoiding mismatches from duplicate names
      const canUnsub = state === 'sub' && (r.subCollab ? r.subCollab.length > 0 : subs.ids.has(r.id));
      const kind = state === 'unsub' ? 'sub' : canUnsub ? 'unsub' : null;
      card.__yousubKind = kind && buttonAllowed(card) ? kind : null;
      // Cache only confirmed channel IDs; reevaluate cards identified only by page text
      card.__yousubSig = r.id ? sig : '';
      done(card, parent);
    }

    fixGridColumns(grids, ready && !!settings.sortUnsub);
    updateAutoload(ready, marked);
    queueHover(); // Page content changed under the cursor

    // The currently open channel page
    channelPage = null;
    const pk = keyFromPath(location.pathname);
    if (ready && pk) {
      const nm = document.querySelector('yt-page-header-renderer h1, #page-header h1, ytd-c4-tabbed-header-renderer #text')?.textContent?.trim() || pk;
      channelPage = { key: pk, name: nm, subscribed: isSubKey(pk) || subs.titles.has(norm(nm)) };
    }
  }

  /* ---------------- sorting: unsubscribed channels first ---------------- */
  // CSS `order` controls sorting (see content.css) without moving YouTube elements.
  // For grids (Home, channel Videos tab), refresh first-column markers to preserve left margins.
  // Sorted, deduplicated video lists (keep in sync with content.css)
  const LIST_SEL = 'ytd-rich-grid-renderer > #contents, ytd-search ytd-item-section-renderer > #contents, #related ytd-item-section-renderer > #contents';
  const isList = (el) => !!el && (el.__yousubList ??= el.matches(LIST_SEL));
  const SORT_RANK = { unsub: -1, sub: 0, left: 1 };
  function sortRank(el) {
    if (el.localName === 'ytd-continuation-item-renderer') return 99;
    if (el.hasAttribute('data-yousub-dup')) return 100; // Hidden cards still shift subsequent grid columns
    return SORT_RANK[el.getAttribute('data-yousub-state')] || 0;
  }
  function fixGridColumns(grids, active) {
    for (const grid of grids) {
      const kids = [...grid.children];
      const ranks = active ? kids.map(sortRank) : [];
      const sig = active ? gen + '|' + getComputedStyle(grid).getPropertyValue('--ytd-rich-grid-items-per-row') + '|' + ranks.join(',') : '';
      if (grid.__yousubSortSig === sig) continue;
      grid.__yousubSortSig = sig;
      const sorted = ranks.map((r, i) => ({ el: kids[i], i, r })).sort((a, b) => a.r - b.r || a.i - b.i);
      if (!active || sorted.every((x, i) => x.i === i)) { // Nothing moved; let YouTube manage the layout
        for (const el of kids) if (el.hasAttribute('data-yousub-col')) el.removeAttribute('data-yousub-col');
        continue;
      }
      const perRowCache = {};
      let col = 0;
      for (const { el } of sorted) {
        const visible = el.getClientRects().length > 0;
        if (el.localName !== 'ytd-rich-item-renderer') { if (visible) col = 0; continue; } // A full-width section starts a new row
        if (!visible) { el.removeAttribute('data-yousub-col'); continue; }
        const v = el.hasAttribute('is-slim-media') ? '--ytd-rich-grid-slim-items-per-row'
          : el.hasAttribute('is-post') ? '--ytd-rich-grid-posts-per-row' : '--ytd-rich-grid-items-per-row';
        const per = perRowCache[v] ??= (parseInt(getComputedStyle(el).getPropertyValue(v), 10) || parseInt(el.getAttribute('items-per-row'), 10) || 3);
        const val = col % per === 0 ? 'first' : 'rest';
        col++;
        if (el.getAttribute('data-yousub-col') !== val) el.setAttribute('data-yousub-col', val);
      }
    }
  }

  /* ---------------- autoload before sorting ----------------
   * YouTube loads more videos when ytd-continuation-item-renderer enters the viewport.
   * While yousub-autoload is active, this element is invisible but stays "on screen" (see content.css),
   * so YouTube keeps loading without scrolling. Stop at AUTOLOAD.limit marked videos (n),
   * or after AUTOLOAD.stallMs without new items. Normal scrolling then resumes.
   */
  const AUTOLOAD_PATH = /^\/(results|watch)?$/; // Home, Search, and Watch pages
  let auto = { page: '', count: -1, since: 0, done: false };

  function updateAutoload(ready, n) {
    const page = location.pathname + location.search;
    if (auto.page !== page) auto = { page, count: -1, since: 0, done: false }; // New page: start again
    let on = false;
    if (ready && settings.sortUnsub && !auto.done && AUTOLOAD_PATH.test(location.pathname)) {
      if (n !== auto.count) { auto.count = n; auto.since = Date.now(); }
      auto.done = n >= AUTOLOAD.limit || Date.now() - auto.since > AUTOLOAD.stallMs;
      on = !auto.done;
    }
    document.documentElement.classList.toggle('yousub-autoload', on);
  }

  let scanTimer = 0;
  function scheduleScan(rescanMain) {
    if (rescanMain) window.postMessage({ source: IN, type: 'rescan' }, location.origin);
    if (!scanTimer) scanTimer = setTimeout(() => { scanTimer = 0; safe(scan)(); }, 300);
  }

  function applySettings() {
    gen++;
    const cl = document.documentElement.classList;
    for (const c of [...cl]) if (c.startsWith('yousub-mode-')) cl.remove(c);
    cl.add('yousub-mode-' + settings.mode);
    cl.toggle('yousub-sort', !!settings.sortUnsub);
    document.documentElement.style.setProperty('--yousub-color', settings.color);
    document.documentElement.style.setProperty('--yousub-left', settings.leftColor);
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
    if (area === 'sync' && changes.yousubSettings) {
      settings = { ...DEFAULTS, ...changes.yousubSettings.newValue };
      applySettings();
    }
    if (area !== 'local') return;
    if (changes.yousubSubs && !syncing) { loadSubs(changes.yousubSubs.newValue); reconcile(); scheduleScan(); }
    if (changes.yousubUnsubs) {
      // Merge with newest-event-wins so pending local records are not overwritten
      const inc = changes.yousubUnsubs.newValue || {};
      const merged = { ...inc };
      for (const [id, e] of Object.entries(unsubs)) if (!merged[id] || e.at > merged[id].at) merged[id] = e;
      unsubs = merged;
      gen++;
      reconcile(); scheduleScan();
    }
  }));

  /* ---------------- init ---------------- */
  async function init() {
    const [{ yousubSettings }, { yousubSubs, yousubUnsubs }] = await Promise.all([
      chrome.storage.sync.get('yousubSettings'), chrome.storage.local.get(['yousubSubs', 'yousubUnsubs'])
    ]);
    unsubs = yousubUnsubs || {};
    safe(() => chrome.runtime.sendMessage({ type: 'drivePull' }).catch(() => {}))(); // Pull changes from other devices
    settings = { ...DEFAULTS, ...yousubSettings };
    loadSubs(yousubSubs);
    reconcile();
    applySettings();

    new MutationObserver((muts) => {
      if (muts.some((m) => (m.type === 'attributes' || m.addedNodes.length) && !inPlayer(m.target))) scheduleScan();
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-yousub-v', 'hidden'] });
    // Fallback every 10 seconds, or 2.5 seconds during autoload to detect an exhausted list
    let tick = 0;
    setInterval(() => extAlive && (++tick % 4 === 0 || document.documentElement.classList.contains('yousub-autoload')) && scheduleScan(), 2500);
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
    const oldFormat = subs.ts && !subs.stats?.status; // Legacy data: refresh once
    if (stale || otherAccount || oldFormat || !subs.list.length) await doSync();
    else scheduleScan();
  }
  init().catch((e) => { lastError = friendlyError(e); });
})();
