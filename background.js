// Service worker (Manifest V3): default settings, stale data cleanup, and Google Drive sync.
importScripts('shared.js', 'drive.js');

const SYNC_ALARM = 'yousub-drive-sync';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.runtime.onInstalled.addListener(async () => {
  const { yousubSettings } = await chrome.storage.sync.get('yousubSettings');
  const s = { ...YOUSUB.DEFAULTS };
  for (const k of Object.keys(s)) if (yousubSettings && k in yousubSettings) s[k] = yousubSettings[k];
  await chrome.storage.sync.set({ yousubSettings: s }); // Keep only supported keys

  const all = await chrome.storage.local.get(null);
  const stale = Object.keys(all).filter((k) => !YOUSUB.STORE_KEYS.includes(k));
  if (stale.length) await chrome.storage.local.remove(stale);
  setupAlarm();
  clearHistoryWhenUnconfigured();
  Drive.sync(); // Read the Drive settings saved in the popup after installation or reload
});
chrome.runtime.onStartup.addListener(() => { setupAlarm(); clearHistoryWhenUnconfigured(); Drive.sync(); });

function setupAlarm() { chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 15 }); }
chrome.alarms.onAlarm.addListener((a) => { if (a.name === SYNC_ALARM) { clearHistoryWhenUnconfigured(); Drive.sync(); } });

// Local unsubscribe history exists only while Drive sync is configured (cached file: client + link).
async function clearHistoryWhenUnconfigured() {
  const { [YOUSUB.CONFIG_KEY]: cfg = {} } = await chrome.storage.local.get(YOUSUB.CONFIG_KEY);
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

let lastPull = 0;
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case 'drivePull': // A YouTube page opened: pull changes from other devices (at most once every two minutes)
      if (Date.now() - lastPull > 120e3) { lastPull = Date.now(); Drive.sync(); }
      return;
    case 'driveSync':
      // Only a click in the panel may open the Google sign-in window.
      Drive.sync({ signIn: msg.signIn === true }).then(sendResponse);
      return true;
    case 'driveSignOut':
      // Revoke the token of the configured client, then report the result of a fresh sync.
      chrome.storage.local.get(YOUSUB.CONFIG_KEY)
        .then(({ [YOUSUB.CONFIG_KEY]: cfg = {} }) => Drive.signOut(cfg.clientId || ''))
        .then(() => Drive.sync())
        .then(sendResponse)
        .catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
  }
});
