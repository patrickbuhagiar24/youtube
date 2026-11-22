/*
 * Yousub diagnostics.
 *
 * Usage: open https://www.youtube.com, press F12 → Console, paste this whole file,
 * press Enter. It prints one block of lines and never changes any setting.
 *
 * Share the output when markers ("+" / "−" / outlines) do not appear.
 */
(async () => {
  const out = [];
  const add = (name, value) => out.push(`${name}: ${value}`);
  const mark = (ok) => (ok ? 'OK' : 'FAIL');

  // 1) Is the extension alive in this tab?
  const alive = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
  add('1. extension context', mark(alive) + (alive ? ` (id ${chrome.runtime.id})` : ' — reload the page after installing/enabling'));
  if (!alive) return console.log('%cYousub\n' + out.join('\n'), 'font-weight:bold');

  // 2) Are the two content scripts running?
  add('2. isolated script', mark(!!window.__YOUSUB_CONTENT__));
  add('3. MAIN-world script', mark(!!window.__YOUSUB_MAIN__) + ' (window.__YOUSUB_MAIN__ is not visible from this console, "FAIL" here is normal on Chrome 116+)');

  // 4) Stored data
  const [{ yousubSettings = {} }, local] = await Promise.all([
    chrome.storage.sync.get('yousubSettings'), chrome.storage.local.get(['yousubSubs', 'yousubDriveConfig'])
  ]);
  const subs = local.yousubSubs || {};
  add('4. setting enabled', yousubSettings.enabled !== false);
  add('5. buttons on videos', yousubSettings.showSubButton !== false);
  add('6. display mode', yousubSettings.mode || 'highlight (default)');
  add('7. subscription list', `${subs.list?.length || 0} channels, ts=${subs.ts || 0}${subs.ts ? '' : ' (never loaded)'}`);
  add('8. list status', subs.stats?.status || '(none)');
  add('9. Drive configured', !!(local.yousubDriveConfig?.link && local.yousubDriveConfig?.keyText));

  // 5) Is the page marked?
  const html = document.documentElement;
  add('10. page flag yousub-on', mark(html.classList.contains('yousub-on')));
  add('11. page classes', html.className || '(none)');
  add('12. marked cards', document.querySelectorAll('[data-yousub-state]').length);
  add('13. corners', `outline=${getComputedStyle(html).getPropertyValue('--yousub-color').trim() || '(unset)'}`);
  add('14. corner buttons', document.querySelectorAll('.yousub-subbtn').length);
  add('15. inline buttons', document.querySelectorAll('.yousub-inlinebtn').length);
  add('16. native YouTube buttons', document.querySelectorAll('ytd-subscribe-button-renderer, yt-subscribe-button-renderer, yt-subscribe-button-view-model').length);

  // 6) State by kind
  const kinds = {};
  for (const el of document.querySelectorAll('[data-yousub-state]')) {
    const kind = el.getAttribute('data-yousub-state');
    kinds[kind] = (kinds[kind] || 0) + 1;
  }
  add('17. states', JSON.stringify(kinds));

  // 7) Can the page ask the MAIN world anything? (2 s round trip)
  const answered = await new Promise((resolve) => {
    const id = 'diag-' + Math.random();
    const onMessage = (event) => {
      if (event.source !== window || event.data?.source !== 'yousub-main') return;
      if (event.data.payload?.reqId !== id) return;
      window.removeEventListener('message', onMessage);
      resolve(event.data);
    };
    window.addEventListener('message', onMessage);
    window.postMessage({ source: 'yousub-content', type: 'hello', reqId: id }, location.origin);
    setTimeout(() => { window.removeEventListener('message', onMessage); resolve(null); }, 2000);
  });
  add('18. MAIN world reply', answered ? `OK (loggedIn=${answered.payload.loggedIn}, account=${answered.payload.accountId})` : 'FAIL — the page world did not answer');

  const ok = out.filter((line) => line.includes(': OK')).length;
  console.log('%cYousub diagnostics — ' + new Date().toISOString() + ` (${ok} checks OK)\n` + out.join('\n'), 'font-weight:bold;color:#1e88e5');
  return out;
})();
