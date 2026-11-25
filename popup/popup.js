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
const EMAIL_KEY = 'yousubOAuthTokens';

async function renderDrive() {
  const keys = ['yousubDrive', 'yousubUnsubs', YOUSUB.CONFIG_KEY, EMAIL_KEY];
  const { yousubDrive: d = {}, yousubUnsubs = {}, [YOUSUB.CONFIG_KEY]: cfg = {}, [EMAIL_KEY]: tokens = {} } =
    await chrome.storage.local.get(keys);
  $('unsubCount').textContent = fmt(Object.values(yousubUnsubs).filter((e) => e.s === 'unsub').length);
  const configured = !!(String(cfg.clientId || '').trim() && String(cfg.link || '').trim());
  $('driveStatus').textContent = !configured
    ? 'Unsubscribe history is kept only while Google Drive sync is configured'
    : !tokens.refresh && !d.email ? '⚙️ Click the button to sign in to Google'
      : d.syncing ? '⏳ Syncing with Google Drive…'
        : d.lastError ? '⚠️ ' + d.lastError
          : d.lastSync ? `☁️ Saved to Google Drive · ${fmtTime(d.lastSync)}` : '⏳ Preparing Google Drive…';
  // The settings button reports the state (⚙️ opens the form) and its tooltip holds the details.
  const setup = $('driveSetupBtn');
  const setupLabel = configured ? 'Google settings' : 'Set up Google Drive sync';
  setup.textContent = '⚙️';
  setup.title = !configured
    ? `${setupLabel}: add your OAuth client and the ${YOUSUB.DRIVE_FILE} link`
    : [setupLabel, d.email || tokens.email || '', cfg.folder ? `folder ${cfg.folder}` : '',
      cfg.files ? `found ${cfg.files.client} and ${cfg.files.drive}` : '',
      d.syncing ? 'syncing…' : d.lastError ? 'needs attention' : d.fileName ? d.fileName : '']
      .filter(Boolean).join(' · ');
  setup.setAttribute('aria-label', setupLabel);
  setup.classList.toggle('configured', configured);
}

/* ---------------- Google settings form ---------------- */

function showSetupStatus(text) { $('setupStatus').textContent = text; }

async function fillSetup() {
  const { [YOUSUB.CONFIG_KEY]: cfg = {} } = await chrome.storage.local.get(YOUSUB.CONFIG_KEY);
  $('clientId').value = cfg.clientId || '';
  $('clientSecret').value = cfg.keyText || '';
  $('driveLink').value = cfg.link || '';
  $('redirectUri').textContent = Drive.redirectUri();
}

$('driveSetupBtn').addEventListener('click', async () => {
  const box = $('googleSetup');
  box.open = true;
  await fillSetup();
  box.scrollIntoView?.({ block: 'nearest' });
});

// Save the three fields, then sign in (the click below is the user gesture the OAuth window needs).
$('saveSetupBtn').addEventListener('click', async () => {
  try {
    const clientId = Drive.clientIdOf($('clientId').value);
    const keyText = $('clientSecret').value.trim();
    const link = $('driveLink').value.trim();
    if (!clientId) throw new Error('Paste the OAuth client ID (it ends with .apps.googleusercontent.com).');
    if (!keyText) throw new Error('Paste the OAuth client secret (Google Cloud Console → Credentials → your client → Client secrets).');
    const fileId = Drive.fileIdOf(link, 'the YouTube.json link field');
    if (!fileId) throw new Error('Paste the link of the YouTube.json file you shared with this Google account.');
    const config = { clientId, keyText, link, folder: '', files: { client: 'client secret', drive: 'file link' } };
    await chrome.storage.local.set({ [YOUSUB.CONFIG_KEY]: config });
    showSetupStatus('Signing in to Google…');
    const result = await chrome.runtime.sendMessage({ type: 'driveSync', signIn: true });
    showSetupStatus(result?.ok ? '✅ Signed in. The history file is being kept up to date.'
      : `⚠️ ${result?.error || 'The sign-in did not finish.'}`);
    await renderDrive();
  } catch (e) {
    showSetupStatus('⚠️ ' + (e.message || String(e)));
  }
});

$('signOutBtn').addEventListener('click', async () => {
  showSetupStatus('Signing out…');
  const result = await chrome.runtime.sendMessage({ type: 'driveSignOut' }).catch((e) => ({ ok: false, error: e.message }));
  showSetupStatus(result?.ok === false && result.error ? `⚠️ ${result.error}` : 'Signed out of Google on this device.');
  await renderDrive();
});

chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'local' && (c[EMAIL_KEY] || c.yousubDrive || c.yousubUnsubs || c[YOUSUB.CONFIG_KEY])) renderDrive();
  if (area === 'local' && c.yousubSubs && tabId === null) renderFromStorage();
});

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
  await refreshActiveTab();
  // Slow fallback for messages lost during navigation or extension reload.
  setInterval(async () => { if (!document.hidden) { const s = await getState(); if (s) render(s); } }, 30000);
})();
