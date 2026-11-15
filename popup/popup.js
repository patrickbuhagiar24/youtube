const { DEFAULTS, STATUS } = YTUC;
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
  const { ytucSettings } = await chrome.storage.sync.get('ytucSettings');
  settings = { ...DEFAULTS, ...ytucSettings };
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
    chrome.storage.sync.set({ ytucSettings: settings });
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
  const { ytucSubs } = await chrome.storage.local.get('ytucSubs');
  renderSummary({ subsCount: ytucSubs?.list?.length || 0, stats: ytucSubs?.stats, ts: ytucSubs?.ts });
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
  const { ytucSubs } = await chrome.storage.local.get('ytucSubs');
  const list = ytucSubs?.list || [];
  if (!list.length) { alert('No list yet. Open YouTube, then click "Refresh list".'); return; }
  const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const rows = [['No.', 'Channel name', 'Handle', 'URL', 'Channel ID'].map(q).join(',')];
  [...list].sort((a, b) => (a.title || '').localeCompare(b.title || '', 'en'))
    .forEach((c, i) => rows.push([i + 1, c.title, c.handle, 'https://www.youtube.com/channel/' + c.id, c.id].map(q).join(',')));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\ufeff' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  a.download = `youtube-subscriptions-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

$('openFeedBtn').addEventListener('click', (e) => e.preventDefault() || chrome.tabs.create({ url: 'https://www.youtube.com/feed/channels' }));

/* ---------------- Google Drive ---------------- */
async function renderDrive() {
  const { ytucDrive: d = {}, ytucUnsubs = {} } = await chrome.storage.local.get(['ytucDrive', 'ytucUnsubs']);
  $('unsubCount').textContent = fmt(Object.values(ytucUnsubs).filter((e) => e.s === 'unsub').length);
  $('driveSyncBtn').classList.toggle('hidden', !d.configured);
  $('driveStatus').textContent = !d.configured ? (d.configPath ? `Google Drive is not configured · ${d.configPath}` : 'Google Drive is not configured (see README)')
    : d.syncing ? '⏳ Syncing with Google Drive…'
      : d.lastError ? '⚠️ ' + d.lastError
        : d.lastSync ? `☁️ Saved to Google Drive · ${fmtTime(d.lastSync)}` : '⏳ Preparing Google Drive…';
}
$('driveSyncBtn').addEventListener('click', async (e) => {
  e.currentTarget.disabled = true;
  await chrome.runtime.sendMessage({ type: 'driveSync' }).catch(() => {});
  $('driveSyncBtn').disabled = false;
  renderDrive();
});
chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && (c.ytucDrive || c.ytucUnsubs)) renderDrive(); });

/* ---------------- startup ---------------- */
(async () => {
  await loadSettings();
  await renderFromStorage();
  renderDrive();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (YT_URL.test(tab?.url || '')) tabId = tab.id;
  render(await getState());
  setInterval(async () => { const s = await getState(); if (s) render(s); }, 1500);
})();
