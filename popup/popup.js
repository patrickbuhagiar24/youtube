const { DEFAULTS, STATUS } = YTUC;
const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n || 0).toLocaleString('id-ID');
const YT_URL = /^https:\/\/www\.youtube\.com\//;
let settings = { ...DEFAULTS };
let tabId = null;

$('ver').textContent = chrome.runtime.getManifest().version;

/* ---------------- pengaturan ---------------- */
// id elemen -> [kunci pengaturan, properti elemen, konversi]
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
  $(id).addEventListener($(id).type === 'color' ? 'input' : 'change', (e) => { // warna: langsung saat digeser
    settings = { ...settings, [key]: conv(e.target[prop]) };
    applyColors();
    chrome.storage.sync.set({ ytucSettings: settings });
  });
}

/* ---------------- tampilan ---------------- */
function fmtTime(ts) {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return 'baru saja';
  if (min < 60) return `${min} menit lalu`;
  if (min < 1440) return `${Math.round(min / 60)} jam lalu`;
  return new Date(ts).toLocaleDateString('id-ID', { day: 'numeric', month: 'long' });
}

function renderSummary({ subsCount, stats, ts }) {
  $('total').textContent = subsCount ? fmt(subsCount) : '–';
  $('status').textContent = ts
    ? [STATUS[stats?.status], `diperbarui ${fmtTime(ts)}`].filter(Boolean).join(' · ')
    : 'Belum ada data — buka youtube.com';
}

async function renderFromStorage() {
  // Angka tetap tampil walau tab yang dibuka bukan YouTube
  const { ytucSubs } = await chrome.storage.local.get('ytucSubs');
  renderSummary({ subsCount: ytucSubs?.list?.length || 0, stats: ytucSubs?.stats, ts: ytucSubs?.ts });
}

function render(state) {
  const sync = $('syncBtn');
  if (!state) {
    const onYt = tabId !== null;
    sync.disabled = true;
    sync.textContent = onYt ? 'Muat ulang halaman YouTube (F5) dulu' : 'Buka YouTube untuk memperbarui';
    return;
  }
  renderSummary(state);
  sync.disabled = !!state.syncing || state.loggedIn === false;
  sync.textContent = state.loggedIn === false ? '🔒 Silakan login YouTube dulu'
    : state.syncing ? `⏳ Memperbarui…${state.syncProgress ? ' ' + fmt(state.syncProgress) + ' channel' : ''}`
      : '🔄 Perbarui daftar';

  $('error').classList.toggle('hidden', !state.lastError);
  $('error').textContent = state.lastError || '';

  const cp = $('channelPage');
  cp.className = state.channelPage ? 'chan ' + (state.channelPage.subscribed ? 'ok' : 'no') : 'chan hidden';
  if (state.channelPage) {
    cp.textContent = `${state.channelPage.subscribed ? '✅' : '❌'} ${state.channelPage.name}: ${state.channelPage.subscribed ? 'sudah' : 'belum'} di-subscribe`;
  }
}

const getState = () => (tabId === null ? null : chrome.tabs.sendMessage(tabId, { type: 'getState' }).catch(() => null));

/* ---------------- tombol ---------------- */
$('syncBtn').addEventListener('click', async () => {
  if (tabId === null) return;
  $('syncBtn').disabled = true;
  $('syncBtn').textContent = '⏳ Memperbarui…';
  const poll = setInterval(async () => render(await getState()), 700);
  try { render(await chrome.tabs.sendMessage(tabId, { type: 'sync' })); } catch { render(null); } finally { clearInterval(poll); }
});

$('exportBtn').addEventListener('click', async (e) => {
  e.preventDefault();
  const { ytucSubs } = await chrome.storage.local.get('ytucSubs');
  const list = ytucSubs?.list || [];
  if (!list.length) { alert('Belum ada daftar. Buka YouTube lalu klik "Perbarui daftar".'); return; }
  const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const rows = [['No', 'Nama channel', 'Handle', 'Link', 'ID channel'].map(q).join(',')];
  [...list].sort((a, b) => (a.title || '').localeCompare(b.title || '', 'id'))
    .forEach((c, i) => rows.push([i + 1, c.title, c.handle, 'https://www.youtube.com/channel/' + c.id, c.id].map(q).join(',')));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['\ufeff' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  a.download = `daftar-subscription-youtube-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});

$('openFeedBtn').addEventListener('click', (e) => e.preventDefault() || chrome.tabs.create({ url: 'https://www.youtube.com/feed/channels' }));

/* ---------------- Google Drive ---------------- */
async function renderDrive() {
  const { ytucDrive: d = {}, ytucUnsubs = {} } = await chrome.storage.local.get(['ytucDrive', 'ytucUnsubs']);
  $('unsubCount').textContent = fmt(Object.values(ytucUnsubs).filter((e) => e.s === 'unsub').length);
  $('driveSyncBtn').classList.toggle('hidden', !d.configured);
  $('driveStatus').textContent = !d.configured ? 'Google Drive belum diatur (lihat README)'
    : d.syncing ? '⏳ Menyinkronkan Google Drive…'
      : d.lastError ? '⚠️ ' + d.lastError
        : d.lastSync ? `☁️ Tersimpan di Google Drive · ${fmtTime(d.lastSync)}` : '⏳ Menyiapkan Google Drive…';
}
$('driveSyncBtn').addEventListener('click', async (e) => {
  e.currentTarget.disabled = true;
  await chrome.runtime.sendMessage({ type: 'driveSync' }).catch(() => {});
  $('driveSyncBtn').disabled = false;
  renderDrive();
});
chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && (c.ytucDrive || c.ytucUnsubs)) renderDrive(); });

/* ---------------- mulai ---------------- */
(async () => {
  await loadSettings();
  await renderFromStorage();
  renderDrive();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (YT_URL.test(tab?.url || '')) tabId = tab.id;
  render(await getState());
  setInterval(async () => { const s = await getState(); if (s) render(s); }, 1500);
})();
