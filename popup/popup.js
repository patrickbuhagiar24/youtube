const { DEFAULTS, STATUS } = YOUSUB;
const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const YT_URL = /^https:\/\/www\.youtube\.com\//;
let settings = { ...DEFAULTS };
let tabId = null;

$('ver').textContent = chrome.runtime.getManifest().version;

/* ---------------- settings ---------------- */
// Element ID -> [setting key, element property, converter]
const FIELDS = {
  enabled: ['enabled', 'checked'],
  mode: ['mode', 'value'],
  color: ['color', 'value'],
  leftColor: ['leftColor', 'value'],
  showSubButton: ['showSubButton', 'checked'],
  sortUnsub: ['sortUnsub', 'checked'],
  autoSyncHours: ['autoSyncHours', 'value', Number]
};

async function loadSettings() {
  const { yousubSettings } = await chrome.storage.sync.get('yousubSettings');
  settings = { ...DEFAULTS, ...yousubSettings };
  for (const [id, [key, prop]] of Object.entries(FIELDS)) $(id)[prop] = prop === 'checked' ? !!settings[key] : String(settings[key]);
  applyColors();
}
function applyColors() {
  document.documentElement.style.setProperty('--accent', settings.color);
  document.documentElement.style.setProperty('--left', settings.leftColor);
}
for (const [id, [key, prop, conv = (v) => v]] of Object.entries(FIELDS)) {
  $(id).addEventListener($(id).type === 'color' ? 'input' : 'change', (e) => { // Update colors immediately while the picker changes
    settings = { ...settings, [key]: conv(e.target[prop]) };
    applyColors();
    chrome.storage.sync.set({ yousubSettings: settings });
  });
}

/* ---------------- display ---------------- */
function fmtTime(ts) {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  if (min < 1440) { const hours = Math.round(min / 60); return `${hours} hour${hours === 1 ? '' : 's'} ago`; }
  return new Date(ts).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });
}

function renderSummary({ subsCount, stats, ts }) {
  $('total').textContent = subsCount ? fmt(subsCount) : '–';
  $('status').textContent = ts
    ? [STATUS[stats?.status], `updated ${fmtTime(ts)}`].filter(Boolean).join(' · ')
    : 'No data yet — open youtube.com';
}

async function renderFromStorage() {
  // Keep showing the count even when the active tab is not YouTube
  const { yousubSubs } = await chrome.storage.local.get('yousubSubs');
  renderSummary({ subsCount: yousubSubs?.list?.length || 0, stats: yousubSubs?.stats, ts: yousubSubs?.ts });
}

function render(state) {
  const sync = $('syncBtn');
  if (!state) {
    const onYt = tabId !== null;
    sync.disabled = true;
    sync.textContent = onYt ? 'Reload the YouTube page (F5) first' : 'Open YouTube to refresh';
    return;
  }
  renderSummary(state);
  sync.disabled = !!state.syncing || state.loggedIn === false;
  sync.textContent = state.loggedIn === false ? '🔒 Sign in to YouTube first'
    : state.syncing ? `⏳ Refreshing…${state.syncProgress ? ' ' + fmt(state.syncProgress) + ' channels' : ''}`
      : '🔄 Refresh list';

  $('error').classList.toggle('hidden', !state.lastError);
  $('error').textContent = state.lastError || '';

  const cp = $('channelPage');
  cp.className = state.channelPage ? 'chan ' + (state.channelPage.subscribed ? 'ok' : 'no') : 'chan hidden';
  if (state.channelPage) {
    cp.textContent = `${state.channelPage.subscribed ? '✅' : '❌'} ${state.channelPage.name}: ${state.channelPage.subscribed ? 'subscribed' : 'not subscribed'}`;
  }
}

const getState = () => (tabId === null ? null : chrome.tabs.sendMessage(tabId, { type: 'getState' }).catch(() => null));

/* ---------------- buttons ---------------- */
$('syncBtn').addEventListener('click', async () => {
  if (tabId === null) return;
  $('syncBtn').disabled = true;
  $('syncBtn').textContent = '⏳ Refreshing…';
  const poll = setInterval(async () => render(await getState()), 700);
  try { render(await chrome.tabs.sendMessage(tabId, { type: 'sync' })); } catch { render(null); } finally { clearInterval(poll); }
});

$('exportBtn').addEventListener('click', async (e) => {
  e.preventDefault();
  const { yousubSubs } = await chrome.storage.local.get('yousubSubs');
  const list = yousubSubs?.list || [];
  if (!list.length) { alert('No list yet. Open YouTube, then click "Refresh list".'); return; }
  const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const rows = [['No.', 'Channel name', 'Handle', 'URL', 'Channel ID'].map(q).join(',')];
  [...list].sort((a, b) => (a.title || '').localeCompare(b.title || '', 'en'))
    .forEach((c, i) => rows.push([i + 1, c.title, c.handle, 'https://www.youtube.com/channel/' + c.id, c.id].map(q).join(',')));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\ufeff' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  a.download = `yousub-subscriptions-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

$('openFeedBtn').addEventListener('click', (e) => e.preventDefault() || chrome.tabs.create({ url: 'https://www.youtube.com/feed/channels' }));

/* ---------------- Google Drive ---------------- */
const FILE_HINT = 'Select both files to save and sync automatically.';
let pendingLink = '';
let pendingKey = '';

const driveError = (message) => {
  $('driveFormError').classList.toggle('hidden', !message);
  $('driveFormError').textContent = message || '';
};

async function readSavedConfig() {
  const { [YOUSUB.CONFIG_KEY]: cfg = {} } = await chrome.storage.local.get(YOUSUB.CONFIG_KEY);
  pendingLink = cfg.link || '';
  pendingKey = cfg.keyText || '';
}

async function renderDrive() {
  const keys = ['yousubDrive', 'yousubUnsubs', YOUSUB.CONFIG_KEY];
  const { yousubDrive: d = {}, yousubUnsubs = {}, [YOUSUB.CONFIG_KEY]: cfg = {} } = await chrome.storage.local.get(keys);
  $('unsubCount').textContent = fmt(Object.values(yousubUnsubs).filter((e) => e.s === 'unsub').length);
  const configured = !!(String(cfg.link || '').trim() && String(cfg.keyText || '').trim());
  $('driveSyncBtn').classList.toggle('hidden', !configured);
  $('driveClearBtn').classList.toggle('hidden', !configured);
  $('driveStatus').textContent = !configured ? 'Google Drive is not configured — open "Google Drive sync" below'
    : d.syncing ? '⏳ Syncing with Google Drive…'
      : d.lastError ? '⚠️ ' + d.lastError
        : d.lastSync ? `☁️ Saved to Google Drive · ${fmtTime(d.lastSync)}` : '⏳ Preparing Google Drive…';
}

async function syncNow() {
  $('driveSyncBtn').disabled = true;
  await chrome.runtime.sendMessage({ type: 'driveSync' }).catch(() => {});
  $('driveSyncBtn').disabled = false;
  renderDrive();
}

$('driveSyncBtn').addEventListener('click', syncNow);

async function saveDriveSettings() {
  try {
    if (!pendingLink || !pendingKey) throw new Error('Select both google-drive.json and service-account.json.');
    Drive.fileIdOf(pendingLink);
    Drive.parseKey(pendingKey);
    await chrome.storage.local.set({ [YOUSUB.CONFIG_KEY]: { link: pendingLink, keyText: pendingKey } });
    driveError('');
    await syncNow();
    return true;
  } catch (e) {
    driveError(e.message || String(e));
    return false;
  }
}

/* The only way to configure Drive: select the two local JSON files. */
async function readConfigFile(input, parse) {
  const file = input.files?.[0];
  if (!file) return null;
  try {
    const value = parse((await file.text()).trim());
    return { value, name: file.name };
  } catch (e) {
    driveError(e.message || String(e));
    return null;
  } finally {
    input.value = ''; // Allow selecting the same file again
  }
}

async function saveWhenBothFilesLoaded() {
  if (!pendingLink || !pendingKey) return;
  if (await saveDriveSettings()) $('fileStatus').textContent = 'Both files loaded and saved.';
}

$('driveLinkFile').addEventListener('change', async () => {
  const result = await readConfigFile($('driveLinkFile'), Drive.linkFromConfig);
  if (!result) return;
  if (!result.value) { driveError('google-drive.json has no file link.'); return; }
  pendingLink = result.value;
  driveError('');
  $('fileStatus').textContent = `${result.name} loaded. Select service-account.json.`;
  await saveWhenBothFilesLoaded();
});

$('driveKeyFile').addEventListener('change', async () => {
  const result = await readConfigFile($('driveKeyFile'), (text) => { Drive.parseKey(text); return text; });
  if (!result) return;
  pendingKey = result.value;
  driveError('');
  $('fileStatus').textContent = `${result.name} loaded. Select google-drive.json.`;
  await saveWhenBothFilesLoaded();
});

$('driveClearBtn').addEventListener('click', async () => {
  await chrome.storage.local.remove([YOUSUB.CONFIG_KEY, 'yousubDrive']);
  pendingLink = '';
  pendingKey = '';
  $('fileStatus').textContent = FILE_HINT;
  driveError('');
  renderDrive();
});

chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'local' && (c.yousubDrive || c.yousubUnsubs || c[YOUSUB.CONFIG_KEY])) renderDrive();
});

/* ---------------- startup ---------------- */
(async () => {
  await loadSettings();
  await renderFromStorage();
  await readSavedConfig();
  $('fileStatus').textContent = pendingLink && pendingKey ? 'Configuration files loaded. Select new files to replace them.' : FILE_HINT;
  renderDrive();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (YT_URL.test(tab?.url || '')) tabId = tab.id;
  render(await getState());
  setInterval(async () => { const s = await getState(); if (s) render(s); }, 1500);
})();
