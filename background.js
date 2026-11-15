// Service worker (Manifest V3): default settings, stale data cleanup, and Google Drive sync.
importScripts('shared.js', 'drive.js');

const SYNC_ALARM = 'ytuc-drive-sync';

chrome.runtime.onInstalled.addListener(async () => {
  const { ytucSettings } = await chrome.storage.sync.get('ytucSettings');
  const s = { ...YTUC.DEFAULTS };
  for (const k of Object.keys(s)) if (ytucSettings && k in ytucSettings) s[k] = ytucSettings[k];
  await chrome.storage.sync.set({ ytucSettings: s }); // Keep only supported keys

  const all = await chrome.storage.local.get(null);
  const stale = Object.keys(all).filter((k) => !YTUC.STORE_KEYS.includes(k));
  if (stale.length) await chrome.storage.local.remove(stale);
  setupAlarm();
  Drive.sync(); // Read the per-user google-drive.json after installation or reload
});
chrome.runtime.onStartup.addListener(() => { setupAlarm(); Drive.sync(); });

function setupAlarm() { chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 15 }); }
chrome.alarms.onAlarm.addListener((a) => { if (a.name === SYNC_ALARM) Drive.sync(); });

// Unsubscribe history changed on this device -> send it to Drive (debounced to batch rapid changes).
let pushTimer = 0;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.ytucUnsubs) return;
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
      Drive.sync().then(sendResponse);
      return true;
  }
});
