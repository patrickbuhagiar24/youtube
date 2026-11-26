// Service worker (Manifest V3): default settings, stale data cleanup, and Google Drive sync.
// Automatic sync has two triggers only: a local unsubscribe (debounced below) and install/update.
// There is no timer, no pull on page load, and nothing runs at browser start.
importScripts('shared.js', 'drive.js');

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(async () => {
  const { yousubSettings } = /** @type {{ [key: string]: any }} */ (await chrome.storage.sync.get('yousubSettings'));
  const s = { ...YOUSUB.DEFAULTS };
  for (const k of Object.keys(s)) if (yousubSettings && k in yousubSettings) s[k] = yousubSettings[k];
  await chrome.storage.sync.set({ yousubSettings: s }); // Keep only supported keys

  const all = await chrome.storage.local.get(null);
  const stale = Object.keys(all).filter((k) => !YOUSUB.STORE_KEYS.includes(k));
  if (stale.length) await chrome.storage.local.remove(stale);
  // The key check above is unchanged since 2.7.0, which lacked the sign-in record; make sure a
  // refresh token written before this build is back when a device has any sign-in to restore.
  await Drive.restoreSignIn();
  clearHistoryWhenUnconfigured();
  Drive.sync(); // Read the Drive settings saved in the popup after installation or reload
});

// Local unsubscribe history exists only while Drive sync is configured (cached file: client + link).
async function clearHistoryWhenUnconfigured() {
  const { [YOUSUB.CONFIG_KEY]: cfg = {} } = /** @type {{ [key: string]: any }} */ (await chrome.storage.local.get(YOUSUB.CONFIG_KEY));
  const configured = !!(String(cfg.clientId || '').trim() && String(cfg.link || '').trim());
  if (!configured) await chrome.storage.local.remove('yousubUnsubs');
}

// Unsubscribe history changed on this device -> send it to Drive (debounced to batch rapid changes).
let pushTimer = 0;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[YOUSUB.CONFIG_KEY]) clearHistoryWhenUnconfigured();
  if (!changes.yousubUnsubs) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => Drive.sync(), 3000);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case 'driveSync':
      // Only a click in the panel may open the Google sign-in window.
      Drive.sync({ signIn: msg.signIn === true }).then(sendResponse);
      return true;
  }
});
