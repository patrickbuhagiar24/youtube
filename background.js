// Service worker (Manifest V3): pengaturan default, pembersihan data lama, sinkron Google Drive.
importScripts('shared.js', 'drive.js');

const SYNC_ALARM = 'ytuc-drive-sync';

chrome.runtime.onInstalled.addListener(async () => {
  const { ytucSettings } = await chrome.storage.sync.get('ytucSettings');
  const s = { ...YTUC.DEFAULTS };
  for (const k of Object.keys(s)) if (ytucSettings && k in ytucSettings) s[k] = ytucSettings[k];
  await chrome.storage.sync.set({ ytucSettings: s }); // hanya kunci yang masih dipakai

  const all = await chrome.storage.local.get(null);
  const stale = Object.keys(all).filter((k) => !YTUC.STORE_KEYS.includes(k));
  if (stale.length) await chrome.storage.local.remove(stale);
  setupAlarm();
  Drive.sync(); // baca drive-config.json setelah dipasang / di-Reload
});
chrome.runtime.onStartup.addListener(() => { setupAlarm(); Drive.sync(); });

function setupAlarm() { chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 15 }); }
chrome.alarms.onAlarm.addListener((a) => { if (a.name === SYNC_ALARM) Drive.sync(); });

// Daftar unsubscribe berubah di perangkat ini -> kirim ke Drive (ditunda sebentar agar perubahan beruntun digabung)
let pushTimer = 0;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.ytucUnsubs) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => Drive.sync(), 3000);
});

let lastPull = 0;
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case 'drivePull': // halaman YouTube dibuka: ambil perubahan dari perangkat lain (paling sering tiap 2 menit)
      if (Date.now() - lastPull > 120e3) { lastPull = Date.now(); Drive.sync(); }
      return;
    case 'driveSync':
      Drive.sync().then(sendResponse);
      return true;
  }
});
