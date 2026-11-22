/*
 * Runs in the YouTube page's MAIN world (access to window.ytcfg and Polymer data).
 *  1. Reads all subscriptions from youtube.com/feed/channels (FEchannels, every page).
 *  2. Writes each card's channel to data-yousub-* attributes for content.js.
 *  3. Records Subscribe / Unsubscribe requests that YouTube itself sends (read-only).
 *
 * Nothing is added to or triggered from YouTube's own Subscribe/Unsubscribe button:
 * only the requests YouTube already makes are observed, so the extension does not
 * run extra work, show extra dialogs, or change the button's behavior.
 */
(() => {
  'use strict';
  if (window.__YOUSUB_MAIN__) return;
  window.__YOUSUB_MAIN__ = true;

  const OUT = 'yousub-main';
  const IN = 'yousub-content';
  const ORIGIN = 'https://www.youtube.com';
  const { CARD_SEL } = YOUSUB;
  const origFetch = window.fetch.bind(window);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const post = (type, payload = {}) => window.postMessage({ source: OUT, type, payload }, location.origin);
  const textOf = (t) => t?.simpleText ?? t?.runs?.map((r) => r.text).join('') ?? t?.content ?? '';
  const isObj = (v) => v && typeof v === 'object';

  /** Traverse an object iteratively. visit(o) returns true to skip its children. */
  function walk(root, visit, skip, limit = 400000) {
    const stack = [root];
    let n = 0;
    while (stack.length && n++ < limit) {
      const o = stack.pop();
      if (!isObj(o)) continue;
      if (Array.isArray(o)) { for (let i = o.length - 1; i >= 0; i--) if (isObj(o[i])) stack.push(o[i]); continue; }
      if (visit(o)) continue;
      for (const k in o) if (isObj(o[k]) && !skip?.has(k)) stack.push(o[k]);
    }
  }

  /* ================================================================== */
  /* ytcfg and InnerTube requests                                       */
  /* ================================================================== */
  function cfg(k) {
    try { return window.ytcfg?.get?.(k) ?? window.ytcfg?.data_?.[k]; } catch { return undefined; }
  }
  async function waitCfg(maxMs = 20000) {
    for (const t0 = Date.now(); Date.now() - t0 < maxMs; await sleep(200)) {
      if (cfg('INNERTUBE_API_KEY') && cfg('INNERTUBE_CONTEXT')) return true;
    }
    return false;
  }
  /** The page data is missing (for example restored from the back/forward cache). */
  const NOT_READY = 'YouTube did not finish loading this page. Go back to YouTube and try again.';
  function getCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&') + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }
  async function sha1Hex(str) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  async function authHeader() {
    const ts = Math.floor(Date.now() / 1000);
    const hash = async (label, v) => `${label} ${ts}_${await sha1Hex(`${ts} ${v} ${ORIGIN}`)}`;
    const sapisid = getCookie('SAPISID') || getCookie('__Secure-3PAPISID');
    if (!sapisid) return null;
    const parts = [await hash('SAPISIDHASH', sapisid)];
    const p1 = getCookie('__Secure-1PAPISID'); if (p1) parts.push(await hash('SAPISID1PHASH', p1));
    const p3 = getCookie('__Secure-3PAPISID'); if (p3) parts.push(await hash('SAPISID3PHASH', p3));
    return parts.join(' ');
  }

  async function innertube(endpoint, body) {
    const key = cfg('INNERTUBE_API_KEY');
    const context = JSON.parse(JSON.stringify(cfg('INNERTUBE_CONTEXT') || {}));
    // Brand accounts require onBehalfOfUser; otherwise the primary account may be used
    const delegated = cfg('DELEGATED_SESSION_ID');
    const ds = String(cfg('DATASYNC_ID') || '').split('||');
    const behalf = delegated || (ds[0] && ds[1] ? ds[0] : '');
    if (behalf) context.user = { ...(context.user || {}), onBehalfOfUser: behalf };

    const headers = {
      'Content-Type': 'application/json',
      'X-Origin': ORIGIN,
      'X-Youtube-Client-Name': String(cfg('INNERTUBE_CONTEXT_CLIENT_NAME') || 1),
      'X-Youtube-Client-Version': String(cfg('INNERTUBE_CLIENT_VERSION') || context.client?.clientVersion || ''),
      'X-Goog-AuthUser': String(cfg('SESSION_INDEX') ?? 0)
    };
    const auth = await authHeader();
    if (auth) headers.Authorization = auth;
    const vd = cfg('VISITOR_DATA') || context.client?.visitorData;
    if (vd) headers['X-Goog-Visitor-Id'] = vd;
    if (delegated) headers['X-Goog-PageId'] = delegated;

    const url = `/youtubei/v1/${endpoint}?prettyPrint=false${key ? `&key=${encodeURIComponent(key)}` : ''}`;
    const res = await origFetch(url, { method: 'POST', credentials: 'include', headers, body: JSON.stringify({ context, ...body }) });
    if (!res.ok) throw new Error(`InnerTube ${endpoint} HTTP ${res.status}`);
    return res.json();
  }

  async function innertubeRetry(endpoint, body, tries = 4) {
    let err;
    for (let i = 0; i < tries; i++) {
      try { return await innertube(endpoint, body); } catch (e) { err = e; await sleep(800 * (i + 1) ** 2); }
    }
    throw err;
  }

  const accountInfo = () => ({
    loggedIn: !!cfg('LOGGED_IN'),
    accountId: [cfg('DATASYNC_ID') || '', cfg('DELEGATED_SESSION_ID') || '', cfg('SESSION_INDEX') ?? ''].join('|')
  });

  /* ================================================================== */
  /* Subscription list: youtube.com/feed/channels                       */
  /* ================================================================== */
  // Response sections that are not part of the channel list
  const SUBS_SKIP = new Set(['header', 'topbar', 'sidebar', 'frameworkUpdates', 'responseContext', 'microformat',
    'metadata', 'trackingParams', 'thumbnail', 'thumbnails', 'accessibility', 'menu', 'loggingDirectives']);

  function entryFromLockup(l) {
    const ch = findChannel(l) || {};
    const id = l.contentId?.startsWith?.('UC') ? l.contentId : /CHANNEL/.test(l.contentType || '') ? ch.id : null;
    if (!id) return null;
    const meta = l.metadata?.lockupMetadataViewModel;
    let handle = '';
    for (const r of meta?.metadata?.contentMetadataViewModel?.metadataRows || []) {
      for (const p of r.metadataParts || []) if (!handle && /^@\S+$/.test(p?.text?.content || '')) handle = p.text.content;
    }
    const url = ch.url || (handle ? '/' + handle : '');
    return { id, title: meta?.title?.content || ch.name || '', url, handle: handle || (url.startsWith('/@') ? url.slice(1) : '') };
  }

  function entryFromRenderer(cr) {
    const url = cr.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || '';
    let handle = url.startsWith('/@') ? url.slice(1) : '';
    if (!handle) for (const t of [textOf(cr.subscriberCountText), textOf(cr.videoCountText)]) if (/^@\S+$/.test(t)) handle = t;
    return { id: cr.channelId, title: textOf(cr.title), url, handle };
  }

  /** Find continuationCommand / nextContinuationData within a node in any format. */
  function tokensIn(node) {
    const out = new Set();
    walk(node, (o) => {
      const t = o.continuationCommand?.token || o.nextContinuationData?.continuation || o.reloadContinuationData?.continuation;
      if (typeof t === 'string' && t) out.add(t);
    });
    return [...out];
  }

  /** Fallback for unknown formats: long strings under token/continuation keys. */
  const TOKEN_KEY = /^(token|continuation|ctoken|nextPageToken|continuationToken)$/i;
  function genericTokens(root) {
    const out = new Set();
    walk(root, (o) => {
      for (const k in o) {
        const v = o[k];
        if (typeof v === 'string' && TOKEN_KEY.test(k) && v.length >= 16 && /^[\w%=-]+$/.test(v)) out.add(v);
      }
    }, null, 300000);
    return [...out];
  }

  /** Collect channels into a map keyed by channelId, plus next-page tokens from one response. */
  function collectChannels(root, map) {
    const tokens = [];
    let added = 0;
    const add = (e) => {
      if (!e?.id) return;
      if (!map.has(e.id)) added++;
      map.set(e.id, { ...map.get(e.id), ...e });
    };
    walk(root, (o) => {
      const cr = o.channelRenderer || o.gridChannelRenderer;
      if (cr?.channelId) { add(entryFromRenderer(cr)); return true; }
      if (o.lockupViewModel) { const e = entryFromLockup(o.lockupViewModel); if (e) { add(e); return true; } }
      if (o.continuationItemRenderer) { tokens.push(...tokensIn(o.continuationItemRenderer)); return true; }
      if (o.nextContinuationData?.continuation) tokens.push(o.nextContinuationData.continuation);
      return false;
    }, SUBS_SKIP);
    return { tokens, added };
  }

  /** FEchannels sort options (Most relevant / Newest activity / A-Z). */
  function findSortOptions(root) {
    const out = new Map();
    walk(root, (o) => {
      for (const it of o.sortFilterSubMenuRenderer?.subMenuItems || []) {
        const ep = it.serviceEndpoint || it.navigationEndpoint || {};
        const token = ep.continuationCommand?.token;
        const params = ep.browseEndpoint?.browseId === 'FEchannels' ? ep.browseEndpoint.params : null;
        const key = token || (params && 'p:' + params);
        if (key && !out.has(key)) out.set(key, { title: it.title || '', selected: !!it.selected, token, params });
      }
    });
    return [...out.values()];
  }

  async function fetchSubscriptions() {
    if (!(await waitCfg())) throw new Error(NOT_READY);
    const info = accountInfo();
    if (!info.loggedIn) return { ...info, list: [] };

    const map = new Map();
    const seen = new Set();
    const stats = { pages: 0, fromFeed: 0, sorts: 1, status: 'complete', note: '' };
    let failed = false;

    const enqueue = (queue, toks) => {
      let n = 0;
      for (const t of toks) if (!seen.has(t)) { seen.add(t); queue.push(t); n++; }
      return n;
    };

    /** Crawl one sort order through its last page. */
    async function crawl(firstData) {
      const before = map.size;
      const queue = [];
      const r0 = collectChannels(firstData, map);
      enqueue(queue, r0.tokens.length ? r0.tokens : genericTokens(firstData));
      let emptyStreak = 0;
      while (queue.length && stats.pages < 3000) {
        post('syncProgress', { count: map.size, pages: stats.pages });
        await sleep(120);
        let data;
        try { data = await innertubeRetry('browse', { continuation: queue.shift() }); } catch { failed = true; continue; }
        stats.pages++;
        const r = collectChannels(data, map);
        const fresh = enqueue(queue, r.tokens.length ? r.tokens : r.added ? genericTokens(data) : []);
        emptyStreak = r.added ? 0 : emptyStreak + 1;
        if (emptyStreak >= 5 && !fresh) break;
      }
      return map.size - before;
    }

    const first = await innertubeRetry('browse', { browseId: 'FEchannels' });
    stats.pages++;
    if (first?.alerts?.some?.((x) => x.alertRenderer?.type === 'ERROR')) throw new Error('YouTube is rejecting requests. Please try again shortly.');
    const n1 = await crawl(first);

    // YouTube sometimes caps one sort order at about 1,000 channels; merge other sort orders
    const capped = n1 >= 990 && n1 <= 1010;
    if (capped) {
      for (const opt of findSortOptions(first)) {
        if (opt.selected || (opt.token && seen.has(opt.token))) continue;
        try {
          if (opt.token) seen.add(opt.token);
          const data = await innertubeRetry('browse', opt.params ? { browseId: 'FEchannels', params: opt.params } : { continuation: opt.token });
          stats.pages++;
          stats.sorts++;
          await crawl(data);
        } catch { failed = true; }
      }
    }

    stats.fromFeed = map.size;
    if (failed) {
      stats.status = 'partial';
      stats.note = 'Part of the list could not be loaded. It is retried automatically the next time YouTube opens.';
    } else if (capped && map.size <= 1010) {
      stats.status = 'capped';
      stats.note = 'YouTube returned only about 1,000 channels, so some channels may be marked incorrectly.';
    } else if (capped) {
      stats.status = 'merged';
    }
    return { ...info, list: [...map.values()], stats };
  }

  /* ---------- Subscribe / unsubscribe directly from the extension ---------- */
  const SUB_PARAMS = { subscribe: 'EgIIAhgA', unsubscribe: 'CgIIAhgA' };
  const hasError = (d) => d?.error || d?.alerts?.some?.((x) => x.alertRenderer?.type === 'ERROR');

  /** Check whether a value is a channel ID (UC...). */
  const isUC = (x) => /^UC[\w-]{10,}$/.test(x || '');
  const cmpName = (s) => String(s || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

  /**
   * Resolve a channel ID (UC...) when the card lacks one. Try these methods in order:
   * 1) channel URL (/@handle, /c/, /user/) via resolve_url, 2) video data (player / next),
   * 3) channel page, 4) name search (only if exactly one name matches).
   */
  async function resolveChannelId({ url, vid, name } = {}) {
    const href = url && !/^\/?$/.test(url) ? new URL(url, ORIGIN).href : '';
    const firstUC = (root) => { let id = ''; walk(root, (o) => { const b = o.browseEndpoint?.browseId; if (isUC(b)) id = b; return !!id; }, null, 20000); return id; };
    const tries = [];
    if (href) tries.push(async () => firstUC((await innertube('navigation/resolve_url', { url: href }))?.endpoint));
    if (vid) {
      tries.push(async () => (await innertube('player', { videoId: vid }))?.videoDetails?.channelId);
      tries.push(async () => {
        const d = await innertube('next', { videoId: vid });
        let id = '';
        walk(d, (o) => { const v = o.videoOwnerRenderer; if (v) id = firstUC(v); return !!id; }, null, 200000);
        return id;
      });
    }
    if (href) {
      tries.push(async () => {
        const html = await (await origFetch(href, { credentials: 'include' })).text();
        return html.match(/"externalId":"(UC[\w-]{22})"/)?.[1] || html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/)?.[1] || '';
      });
    }
    if (name && !/,/.test(name)) {
      tries.push(async () => {
        const d = await innertube('search', { query: name, params: 'EgIQAg==' }); // Channel filter
        const hits = new Set();
        walk(d, (o) => { const c = o.channelRenderer; if (c && cmpName(textOf(c.title)) === cmpName(name) && isUC(c.channelId)) hits.add(c.channelId); return !!c; }, null, 200000);
        return hits.size === 1 ? [...hits][0] : '';
      });
    }
    for (const t of tries) {
      try { const id = await t(); if (isUC(id)) return id; } catch { /* Try the next method */ }
    }
    throw new Error('Could not find this channel ID. Open the channel page and click Subscribe there.');
  }

  /** Subscribe or unsubscribe one or more channels (collaborations). Return successful IDs. */
  async function changeSubscription(action, ids, hint = {}) {
    if (!SUB_PARAMS[action]) throw new Error('Unknown action');
    if (!(await waitCfg(5000))) throw new Error(NOT_READY);
    if (!cfg('LOGGED_IN')) throw new Error('Please sign in to YouTube first.');
    ids = (Array.isArray(ids) ? ids : [ids]).filter(isUC);
    if (!ids.length) ids = [await resolveChannelId(hint)];
    const done = [];
    let err = null;
    for (const id of ids) { // One at a time, like YouTube's Collaborators dialog
      try {
        const d = await innertube(`subscription/${action}`, { channelIds: [id], params: SUB_PARAMS[action] });
        let state = null;
        walk(d, (o) => { const a = o.updateSubscribeButtonAction; if (typeof a?.subscribed === 'boolean') state = a.subscribed; });
        if (hasError(d) || (state !== null && state !== (action === 'subscribe'))) {
          throw new Error('YouTube rejected this request. You may have reached the daily subscription limit; try again tomorrow.');
        }
        done.push(id);
      } catch (e) { err = e; }
      if (ids.length > 1) await sleep(300);
    }
    if (!done.length) throw err;
    return done;
  }

  /* ================================================================== */
  /* Channel owning each card                                           */
  /* ================================================================== */
  // Do NOT skip 'rendererContext': new lockup avatars store browseEndpoint inside it.
  const SKIP_KEYS = new Set(['thumbnail', 'thumbnails', 'accessibility', 'trackingParams', 'loggingDirectives',
    'thumbnailOverlays', 'menu', 'contentImage', 'richThumbnail', 'inlinePlaybackEndpoint']);
  const INDEX_SKIP = new Set([...SKIP_KEYS, 'rendererContext', 'frameworkUpdates', 'responseContext', 'playerOverlays',
    'microformat', 'streamingData', 'playbackTracking', 'storyboards', 'heartbeatParams', 'attestation']);
  const VIDEO_KEYS = ['videoRenderer', 'compactVideoRenderer', 'gridVideoRenderer', 'playlistVideoRenderer',
    'playlistPanelVideoRenderer', 'endScreenVideoRenderer', 'movieRenderer', 'compactMovieRenderer'];

  function getData(el) {
    try { return el.data || el.__data?.data || el.polymerController?.data || el.inst?.data || null; } catch { return null; }
  }

  /** First channel in the data, depth-first in original key order. */
  function findChannel(root) {
    const seen = new Set();
    const rec = (o, depth) => {
      if (!isObj(o) || depth > 18 || seen.has(o)) return null;
      seen.add(o);
      if (o.adSlotRenderer || o.promotedSparklesWebRenderer) return { ad: true };
      if (typeof o.channelId === 'string' && o.channelId.startsWith('UC') && (o.title || o.subscriberCountText)) {
        return { id: o.channelId, url: o.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || '', name: textOf(o.title) };
      }
      const ne = o.navigationEndpoint?.browseEndpoint;
      if (ne?.browseId?.startsWith?.('UC')) {
        return { id: ne.browseId, url: ne.canonicalBaseUrl || '', name: typeof o.text === 'string' ? o.text : textOf(o.title) };
      }
      const be = o.browseEndpoint;
      if (be?.browseId?.startsWith?.('UC')) return { id: be.browseId, url: be.canonicalBaseUrl || '', name: '' };
      if (Array.isArray(o)) { for (const x of o) { const f = rec(x, depth + 1); if (f) return f; } return null; }
      for (const k in o) { if (SKIP_KEYS.has(k)) continue; const f = rec(o[k], depth + 1); if (f) return f; }
      return null;
    };
    return rec(root, 0);
  }

  /** Collaborators from a collaboration video's dialog; null for non-collaborations. */
  function collaborators(root) {
    let found = null;
    walk(root, (o) => {
      if (found) return true;
      const items = o.showDialogCommand?.panelLoadingStrategy?.inlineContent?.dialogViewModel?.customContent?.listViewModel?.listItems;
      if (!Array.isArray(items)) return false;
      const out = [];
      for (const it of items) {
        const v = it?.listItemViewModel;
        if (!v) continue;
        let id = '', url = '';
        walk(v, (x) => {
          const b = x.browseEndpoint;
          if (!id && b?.browseId?.startsWith?.('UC')) { id = b.browseId; url = b.canonicalBaseUrl || ''; }
          return !!id;
        }, null, 5000);
        if (id && !out.some((c) => c.id === id)) out.push({ id, name: (v.title?.content || '').trim(), url });
      }
      if (out.length > 1) found = out;
      return true;
    }, SKIP_KEYS, 60000); // Intentionally include 'rendererContext': the dialog is often attached to the avatar
    return found;
  }

  const lockupName = (l) =>
    (l?.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content || '').trim();

  /* ---------- videoId -> channel map (from InnerTube responses) ---------- */
  const videoMap = new Map();
  let mapVersion = 0;

  function remember(vid, ch) {
    if (!vid || !ch) return;
    if (!ch.id && ch.collab) ch = { ...ch, id: ch.collab[0].id, url: ch.collab[0].url, name: ch.name || ch.collab.map((c) => c.name).join(', ') };
    if (!ch.id && !ch.name) return;
    const old = videoMap.get(vid);
    if (old && (old.id || !ch.id) && old.name && (old.collab || !ch.collab)) return;
    videoMap.set(vid, { id: ch.id || old?.id || '', url: ch.url || old?.url || '', name: ch.name || old?.name || '', collab: ch.collab || old?.collab || null });
    mapVersion++;
    if (videoMap.size > 8000) videoMap.delete(videoMap.keys().next().value);
  }

  function indexData(root) {
    if (!isObj(root)) return;
    walk(root, (o) => {
      const l = o.lockupViewModel;
      if (l?.contentId && /VIDEO/.test(l.contentType || 'VIDEO')) {
        const ch = findChannel(l) || {};
        remember(l.contentId, { id: ch.id, url: ch.url, name: ch.name || lockupName(l), collab: collaborators(l) });
      }
      for (const k of VIDEO_KEYS) {
        const vr = o[k];
        if (vr?.videoId) { const ch = findChannel(vr); if (ch && !ch.ad) remember(vr.videoId, { ...ch, collab: collaborators(vr) }); }
      }
    }, INDEX_SKIP);
  }
  const safeIndex = (d) => { try { indexData(d); scheduleScan(); } catch { /* */ } };

  function videoIdOf(el, d) {
    const c = d && (d.contentId || d.videoId || d.content?.lockupViewModel?.contentId || d.content?.videoRenderer?.videoId);
    if (typeof c === 'string' && /^[\w-]{11}$/.test(c)) return c;
    const h = el.querySelector('a[href*="/watch?v="], a[href^="/shorts/"]')?.getAttribute('href') || '';
    if (/[?&]list=RD|start_radio=1/.test(h)) return ''; // YouTube-generated Mix
    return (h.match(/[?&]v=([\w-]{11})/) || h.match(/\/shorts\/([\w-]{11})/))?.[1] || '';
  }

  /* ---------- Write data-yousub-* attributes to each card ---------- */
  let dataCache = new WeakMap();
  let containerCache = new WeakMap();
  let ver = 0;

  function setAttr(el, name, val) {
    if (val) { if (el.getAttribute(name) !== val) el.setAttribute(name, val); }
    else if (el.hasAttribute(name)) el.removeAttribute(name);
  }

  const CONTAINERS = new Set(['ytd-watch-next-secondary-results-renderer', 'ytd-item-section-renderer',
    'ytd-rich-grid-renderer', 'ytd-section-list-renderer', 'ytd-playlist-panel-renderer', 'ytd-watch-flexy']);
  const SCAN_SEL = [...CONTAINERS, CARD_SEL].join(',');

  function scan() {
    // Traverse the DOM once (pages may contain tens of thousands of elements), then group by type
    const containers = [], cards = [];
    for (const el of document.querySelectorAll(SCAN_SEL)) (CONTAINERS.has(el.localName) ? containers : cards).push(el);

    // 1) Index changed container data (watch sidebar, home grid, search results)
    for (const c of containers) {
      const d = getData(c) || (c.localName === 'ytd-watch-flexy' ? c.__data?.watchNextData || c.watchNextData : null);
      if (d && containerCache.get(c) !== d) { containerCache.set(c, d); try { indexData(d); } catch { /* */ } }
    }

    // 2) Channel owning each card
    for (const el of cards) {
      const d = getData(el);
      const vid = videoIdOf(el, d);
      const prev = dataCache.get(el);
      if (prev && prev.d === d && prev.vid === vid && (prev.resolved || prev.mv === mapVersion)) continue;

      let ch = d ? findChannel(d) : null;
      if (ch?.ad) {
        dataCache.set(el, { d, vid, mv: mapVersion, resolved: true });
        setAttr(el, 'data-yousub-ad', '1');
        el.setAttribute('data-yousub-v', String(++ver));
        continue;
      }
      const fromMap = vid ? videoMap.get(vid) : null;
      if (fromMap && !ch?.id) ch = { ...fromMap, name: ch?.name || fromMap.name };
      if (ch && !ch.name) ch.name = lockupName(d?.content?.lockupViewModel || d) || fromMap?.name || '';
      const collab = (d && collaborators(d)) || fromMap?.collab || null;
      if (collab && !ch?.id) ch = { id: collab[0].id, url: collab[0].url, name: collab.map((c) => c.name).join(', ') };
      const collabAttr = collab ? JSON.stringify(collab) : '';

      dataCache.set(el, { d, vid, mv: mapVersion, resolved: !!ch?.id });
      const changed = el.getAttribute('data-yousub-cid') !== (ch?.id || null) || el.getAttribute('data-yousub-name') !== (ch?.name || null) ||
        (el.getAttribute('data-yousub-collab') || '') !== collabAttr;
      setAttr(el, 'data-yousub-cid', ch?.id || '');
      setAttr(el, 'data-yousub-url', ch?.url || '');
      setAttr(el, 'data-yousub-name', ch?.name || '');
      setAttr(el, 'data-yousub-vid', vid);
      setAttr(el, 'data-yousub-collab', collabAttr);
      setAttr(el, 'data-yousub-ad', '');
      if (changed || !prev || prev.vid !== vid) el.setAttribute('data-yousub-v', String(++ver));
    }
  }

  let scanTimer = 0;
  const scheduleScan = () => { if (!scanTimer) scanTimer = setTimeout(() => { scanTimer = 0; scan(); }, 250); };

  function start() {
    // Ignore player-only changes (time, progress bar) that do not affect cards
    new MutationObserver((muts) => { if (muts.some((m) => !m.target.closest?.('.html5-video-player') && !m.target.closest?.('ytd-page-manager > [hidden]'))) scheduleScan(); })
      .observe(document.documentElement, { childList: true, subtree: true });
    // Safety-net scan every 10 seconds; normal scans are triggered by DOM changes,
    // navigation, and InnerTube responses. YouTube's own button is never polled.
    setInterval(() => { if (!document.hidden) scan(); }, 10000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleScan(); });
    for (const e of ['yt-navigate-finish', 'yt-page-data-updated', 'yt-action']) document.addEventListener(e, scheduleScan);
    document.addEventListener('yt-navigate-finish', (e) => safeIndex(e.detail?.response?.response || e.detail?.response));
    document.addEventListener('yt-page-data-fetched', (e) => safeIndex(e.detail?.pageData?.response));
    safeIndex(window.ytInitialData);
    scan();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();

  /* ================================================================== */
  /* Network hooks: new video data and subscribe/unsubscribe actions    */
  /* ================================================================== */
  const INDEX_URL = /\/youtubei\/v1\/(next|browse|search|reel)/;
  const SUB_URL = /\/youtubei\/v1\/subscription\/(subscribe|unsubscribe)/;

  // Observe YouTube's own requests without issuing another subscription request.
  // Results are applied only after a successful response, not on click or dialog
  // opening, so no extra refresh runs when the native button is merely pressed.
  function reportNativeChange(url, body, response) {
    const match = SUB_URL.exec(url || '');
    if (!match || !response || hasError(response)) return;
    const subscribed = match[1] === 'subscribe';
    let state = null;
    walk(response, (o) => {
      const action = o.updateSubscribeButtonAction;
      if (typeof action?.subscribed === 'boolean') state = action.subscribed;
    });
    if (state !== null && state !== subscribed) return;
    try {
      const data = typeof body === 'string' ? JSON.parse(body) : body;
      const ids = Array.isArray(data?.channelIds) ? data.channelIds.filter(isUC) : [];
      // Without a valid channel ID nothing is applied: the extension never guesses.
      if (ids.length) post('subChange', { ids, subscribed });
    } catch { /* Unknown request body; nothing to apply. */ }
  }

  window.fetch = async function (input, init) {
    let url = '';
    try { url = typeof input === 'string' ? input : input?.url || String(input); } catch { /* */ }
    const sub = SUB_URL.test(url);
    let body = null;
    if (sub) {
      try { body = init?.body != null ? Promise.resolve(init.body) : input instanceof Request ? input.clone().text() : null; } catch { /* */ }
    }
    const res = await origFetch(input, init);
    if (res.ok && INDEX_URL.test(url)) {
      try { res.clone().json().then(safeIndex, () => {}); } catch { /* */ }
    }
    if (res.ok && body) {
      try {
        Promise.all([body, res.clone().json()]).then(([request, result]) => reportNativeChange(url, request, result)).catch(() => {});
      } catch { /* The response cannot be read; nothing to apply. */ }
    }
    return res;
  };

  // Some YouTube requests use XHR instead of fetch.
  try {
    const { open, send } = XMLHttpRequest.prototype;
    XMLHttpRequest.prototype.open = function (method, url) { this.__yousubUrl = String(url || ''); return open.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function (body) {
      const url = this.__yousubUrl || '';
      if (INDEX_URL.test(url) || SUB_URL.test(url)) {
        this.addEventListener('load', () => {
          if (this.status < 200 || this.status >= 300) return;
          try {
            const result = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
            if (INDEX_URL.test(url)) safeIndex(result);
            if (SUB_URL.test(url)) reportNativeChange(url, body, result);
          } catch { /* The response cannot be read; nothing to apply. */ }
        }, { once: true });
      }
      return send.apply(this, arguments);
    };
  } catch { /* */ }

  /* ================================================================== */
  /* Communication with the content script                              */
  /* ================================================================== */
  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.data?.source !== IN) return;
    const { type, reqId } = e.data;
    if (type === 'hello') {
      await waitCfg();
      post('hello', { reqId, ...accountInfo() });
    } else if (type === 'sync') {
      try { post('subs', { reqId, ...(await fetchSubscriptions()) }); } catch (err) { post('subsError', { reqId, error: String(err?.message || err) }); }
    } else if (type === 'subscription') {
      try { post('subscriptionDone', { reqId, ids: await changeSubscription(e.data.action, e.data.ids, { url: e.data.url, vid: e.data.vid, name: e.data.name }) }); } catch (err) { post('subsError', { reqId, error: String(err?.message || err) }); }
    } else if (type === 'rescan') {
      dataCache = new WeakMap();
      containerCache = new WeakMap();
      scan();
    }
  });
})();
