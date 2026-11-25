/*
 * Yousub diagnostics.
 *
 * How to use: open https://www.youtube.com, press F12 → Console, paste this whole file,
 * press Enter. It prints one block of lines and changes no settings.
 *
 * Read the *_page_* lines first: a page cannot see extension APIs, so those checks look for
 * what the extension already wrote into the page (the `yousub-*` classes and attributes).
 */
(async () => {
  const out = [];
  const add = (name, value) => out.push(`${name}: ${value}`);
  const ok = 'OK';
  const bad = 'FAIL';
  const mark = (value) => (value ? ok : bad);

  /* 1) What this console can and cannot see -------------------------------- */
  const extApi = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
  add('0. console type', extApi
    ? 'inside the extension (side panel) — extension APIs are visible'
    : 'inside the page — extension APIs are hidden here, this is normal');

  /* 2) Evidence that the content scripts are running (page side) ------------ */
  const html = document.documentElement;
  const cards = document.querySelectorAll('[data-yousub-state]').length;
  const pageFlag = html.classList.contains('yousub-on');
  const flagged = html.className.split(/\s+/).filter((name) => name.startsWith('yousub-'));
  const running = html.getAttribute('data-yousub-version');
  add('1. page_ext_version', running ? `${ok} (${running} running on this page)` : `${bad} — the content script never ran here`);
  add('1b. page_yousub_classes', flagged.length ? `${ok} (${flagged.join(' ')})` : `${bad} — no yousub-* class on <html>`);
  add('2. page_marked_cards', cards ? `${ok} (${cards} cards)` : `${bad} — no data-yousub-state attribute anywhere`);
  add('3. page_script_alive', mark(cards > 0 || flagged.length > 0) + (cards || flagged.length ? '' : ' — neither script left any trace in the page'));

  /* 3) Interface elements (page side) --------------------------------------- */
  add('4. page_corner_buttons', document.querySelectorAll('.yousub-subbtn').length);
  add('5. page_inline_buttons', document.querySelectorAll('.yousub-inlinebtn').length);
  add('6. page_native_buttons', document.querySelectorAll('ytd-subscribe-button-renderer, yt-subscribe-button-renderer, yt-subscribe-button-view-model').length);
  // YouTube's button is not always inside a video card (watch page owner row, channel header).
  // Those buttons get the copy too, so report them separately from the card buttons.
  // Same card list as shared.js (YOUSUB is not visible from the page console)
  const cardSel = ['ytd-rich-item-renderer', 'ytd-video-renderer', 'ytd-compact-video-renderer',
    'ytd-grid-video-renderer', 'ytd-playlist-renderer', 'ytd-compact-playlist-renderer',
    'ytd-channel-renderer', 'ytd-grid-channel-renderer', 'ytd-playlist-video-renderer',
    'ytd-playlist-panel-video-renderer', 'ytd-movie-renderer', 'ytd-compact-movie-renderer',
    'ytd-video-owner-renderer', 'yt-lockup-view-model'].join(',');
  const cardEls = [...document.querySelectorAll(cardSel)];
  const isInCard = (el) => cardEls.some((c) => c.contains(el));
  const loose = [...document.querySelectorAll('ytd-subscribe-button-renderer, yt-subscribe-button-renderer, yt-subscribe-button-view-model')]
    .filter((b) => !b.parentElement?.matches?.('ytd-subscribe-button-renderer, yt-subscribe-button-renderer, yt-subscribe-button-view-model'))
    .filter((b) => !isInCard(b));
  add('6b. page_outside_card_buttons', loose.length);
  add('6c. page_outside_card_inline', loose.filter((b) => b.parentElement?.querySelector('.yousub-inline-host')).length);
  add('6d. page_outside_card_row', loose.map((b) => {
    const host = b.parentElement?.querySelector('.yousub-inline-host');
    if (!host) return 'none';
    return host.previousElementSibling === b ? 'beside' : 'moved';
  }).join(',') || '-');
  // Layout of the row holding the copy: a column row (or one that still wraps) is why the copy
  // would be drawn under the button instead of beside it.
  add('6e. page_outside_card_layout', loose.map((b) => {
    const parent = b.parentElement;
    if (!parent) return '-';
    const style = getComputedStyle(parent);
    return `${style.display}/${style.flexDirection || '-'}/${style.flexWrap || '-'}` +
      (parent.classList.contains('yousub-native-row') ? '/fixed' : '') +
      (parent.__yousubRowFixed ? '/decided' : '');
  }).join(',') || '-');

  const kinds = {};
  for (const element of document.querySelectorAll('[data-yousub-state]')) {
    const kind = element.getAttribute('data-yousub-state');
    kinds[kind] = (kinds[kind] || 0) + 1;
  }
  add('7. page_states', Object.keys(kinds).length ? JSON.stringify(kinds) : '(none)');
  add('8. page_flag_yousub_on', mark(pageFlag) + (pageFlag ? '' : ' — the extension considers the page "not ready": list not loaded, disabled, or signed out'));

  /* 4) Can the page-world script answer? (2 s round trip) ------------------- */
  const reply = await new Promise((resolve) => {
    const requestId = 'yousub-diag-' + Math.random().toString(36).slice(2);
    const onMessage = (event) => {
      if (event.source !== window || event.data?.source !== 'yousub-main') return;
      if (event.data.payload?.reqId !== requestId) return;
      window.removeEventListener('message', onMessage);
      resolve(event.data);
    };
    window.addEventListener('message', onMessage);
    window.postMessage({ source: 'yousub-content', type: 'hello', reqId: requestId }, location.origin);
    setTimeout(() => { window.removeEventListener('message', onMessage); resolve(null); }, 2000);
  });
  add('9. page_world_reply', reply
    ? `${ok} (loggedIn=${reply.payload.loggedIn}, account=${reply.payload.accountId})`
    : `${bad} — the MAIN-world script did not answer (blocked, or not injected)`);

  /* 5) Extension storage (only visible from an extension page) -------------- */
  if (extApi) {
    try {
      const [{ yousubSettings = {} }, local] = await Promise.all([
        chrome.storage.sync.get('yousubSettings'),
        chrome.storage.local.get(['yousubSubs', 'yousubDriveConfig'])
      ]);
      const subs = local.yousubSubs || {};
      add('10. ext_setting_enabled', yousubSettings.enabled !== false);
      add('11. ext_setting_buttons', yousubSettings.showSubButton !== false);
      add('12. ext_display_mode', yousubSettings.mode || 'highlight (default)');
      add('13. ext_subscription_list', `${subs.list?.length || 0} channels, ts=${subs.ts || 0}${subs.ts ? '' : ' — never loaded'}`);
      add('14. ext_list_status', subs.stats?.status || '(none)');
      add('15. ext_drive_configured', !!(local.yousubDriveConfig?.link && local.yousubDriveConfig?.clientId));
    } catch (error) {
      add('10. ext_storage', `${bad} — ${error.message}`);
    }
  } else {
    add('10. ext_storage', 'not visible from the page — open the side panel to check the channel count and Drive status');
  }

  const failures = out.filter((line) => line.includes(bad)).length;
  const header = failures
    ? `Yousub diagnostics — ${failures} check(s) FAIL — copy everything from "0." down`
    : 'Yousub diagnostics — all checks OK — copy everything from "0." down';
  console.log('%c' + header + '\n' + out.join('\n'), 'font-weight:bold;color:#1e88e5');
  return out;
})();
