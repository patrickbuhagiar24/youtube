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
  autoloadLimit: ['autoloadLimit', 'value', Number]
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
  if (!state) {
    // Keep the stored count, but say what the page state is (the list refreshes by itself).
    $('status').textContent = tabId === null ? 'Open youtube.com' : 'Waiting for this YouTube tab…';
    return;
  }
  renderSummary(state);
  if (state.syncing) $('status').textContent = `⏳ Refreshing…${state.syncProgress ? ' ' + fmt(state.syncProgress) + ' channels' : ''}`;
  else if (state.loggedIn === false) $('status').textContent = '🔒 Sign in to YouTube first';

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
$('exportBtn').addEventListener('click', async (e) => {
  e.preventDefault();
  const { yousubSubs } = await chrome.storage.local.get('yousubSubs');
  const list = yousubSubs?.list || [];
  if (!list.length) { alert('No list yet. Open youtube.com and sign in; the list loads automatically.'); return; }
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
async function renderDrive() {
  const keys = ['yousubDrive', 'yousubUnsubs', YOUSUB.CONFIG_KEY];
  const { yousubDrive: d = {}, yousubUnsubs = {}, [YOUSUB.CONFIG_KEY]: cfg = {} } = await chrome.storage.local.get(keys);
  $('unsubCount').textContent = fmt(Object.values(yousubUnsubs).filter((e) => e.s === 'unsub').length);
  const configured = !!(String(cfg.link || '').trim() && String(cfg.keyText || '').trim());
  $('driveStatus').textContent = !configured ? 'Unsubscribe history is kept only while Google Drive sync is configured'
    : d.syncing ? '⏳ Syncing with Google Drive…'
      : d.lastError ? '⚠️ ' + d.lastError
        : d.lastSync ? `☁️ Saved to Google Drive · ${fmtTime(d.lastSync)}` : '⏳ Preparing Google Drive…';
  // Configuration status: the row states whether a manifest is loaded and which file it points at.
  const account = d.email || 'service account';
  const found = cfg.folder ? ` · folder ${cfg.folder}` : '';
  $('driveConfig').textContent = !configured ? '❌ Not configured — choose a folder with 📁'
    : d.syncing ? `✅ Configured · ${account}${found} · ⏳ syncing…`
      : d.lastError ? `✅ Configured · ${account}${found} · ⚠️ needs attention`
        : `✅ Configured · ${account}${found}${d.fileName ? ' · ' + d.fileName : ''}`;
  $('driveConfig').title = configured && cfg.files
    ? `Found in the folder: ${cfg.files.serviceAccount} and ${cfg.files.drive}`
    : '';
  // Once configured, the same picker replaces the saved configuration instead of setting it up.
  const setup = $('driveSetupBtn');
  const setupLabel = configured ? 'Choose another configuration folder' : 'Choose the configuration folder';
  setup.textContent = configured ? '🔁' : '📁';
  setup.title = setupLabel;
  setup.setAttribute('aria-label', setupLabel);
  setup.classList.toggle('configured', configured);
}

/* ---------------- Google Drive configuration: one folder, files found inside ---------------- */

/** Read the chosen folder and store the Drive configuration it contains. */
async function loadFolder(handle) {
  $('driveStatus').textContent = 'Searching this folder for the configuration files…';
  const config = await YousubFolder.read(handle, (driveText) => {
    // Same rules as before, applied to the file found in the folder
    const link = Drive.linkFromConfig(driveText);
    if (!Drive.fileIdOf(link)) throw new Error('The Drive configuration must contain a valid file link.');
    return link;
  });
  await YousubFolder.remember(handle);
  await chrome.storage.local.set({ [YOUSUB.CONFIG_KEY]: config });
  await chrome.runtime.sendMessage({ type: 'driveSync' }).catch(() => {});
  await renderDrive();
  return config;
}

$('driveSetupBtn').addEventListener('click', async () => {
  if (!window.showDirectoryPicker) {
    $('driveStatus').textContent = 'This browser does not support the folder picker.';
    return;
  }
  try {
    // Start the picker inside the click gesture. The side panel stays open on Linux.
    const handle = await window.showDirectoryPicker({ id: 'yousub-config', mode: 'read' });
    await loadFolder(handle);
  } catch (e) {
    if (e.name !== 'AbortError') $('driveStatus').textContent = 'Could not read this folder: ' + (e.message || String(e));
  }
});

// The remembered folder is re-read when the panel opens, so edits to its files are picked up
// without choosing the folder again. A missing permission is asked for once, and only if the
// configuration is already in use (never on a bare panel open without a user action).
let folderChecked = false;
async function refreshFromFolder() {
  if (folderChecked) return;
  folderChecked = true;
  const handle = await YousubFolder.remembered();
  const { [YOUSUB.CONFIG_KEY]: cfg = {} } = await chrome.storage.local.get(YOUSUB.CONFIG_KEY);
  const configured = !!(String(cfg.link || '').trim() && String(cfg.keyText || '').trim());
  if (!handle || !configured) return;
  try {
    if (!(await YousubFolder.usable(handle))) return;
    await loadFolder(handle);
  } catch (e) {
    $('driveStatus').textContent = '⚠️ ' + (e.message || String(e));
  }
}

chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'local' && (c.yousubDrive || c.yousubUnsubs || c[YOUSUB.CONFIG_KEY])) renderDrive();
  if (area === 'local' && c.yousubSubs && tabId === null) renderFromStorage();
});

// The active YouTube tab pushes changes instead of being polled continuously.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'yousubStateChanged' && sender.tab?.id === tabId) render(message.state);
});

/* The side panel stays open while the active tab changes. */
async function refreshActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = YT_URL.test(tab?.url || '') ? tab.id : null;
  render(await getState());
}
chrome.tabs.onActivated.addListener(refreshActiveTab);
chrome.tabs.onUpdated.addListener((id, change) => {
  if (change.url || change.status === 'complete') refreshActiveTab();
});

/* ---------------- startup ---------------- */
(async () => {
  await loadSettings();
  await renderFromStorage();
  await renderDrive();
  await refreshFromFolder();
  await refreshActiveTab();
  // Slow fallback for messages lost during navigation or extension reload.
  setInterval(async () => { if (!document.hidden) { const s = await getState(); if (s) render(s); } }, 30000);
})();
