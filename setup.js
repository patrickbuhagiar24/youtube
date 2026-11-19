const { CONFIG_KEY } = YOUSUB;
const $ = (id) => document.getElementById(id);
$('ver').textContent = chrome.runtime.getManifest().version;

const FILE_HINT = 'Select both files to save and sync automatically.';
let pendingLink = '';
let pendingKey = '';

const showError = (message) => {
  $('driveFormError').classList.toggle('hidden', !message);
  $('driveFormError').textContent = message || '';
};

async function renderSaved() {
  const { [CONFIG_KEY]: cfg = {} } = await chrome.storage.local.get(CONFIG_KEY);
  const saved = !!(String(cfg.link || '').trim() && String(cfg.keyText || '').trim());
  $('setupClearBtn').classList.toggle('hidden', !saved);
  if (saved) $('fileStatus').textContent = 'Configuration files are saved in this browser profile. Select new files to replace them.';
}
renderSaved();

async function readFile(input, parse) {
  const file = input.files?.[0];
  if (!file) return null;
  $('fileStatus').textContent = `Reading ${file.name}…`;
  try {
    const value = parse((await file.text()).trim());
    return { value, name: file.name };
  } catch (e) {
    showError(e.message || String(e));
    return null;
  } finally {
    input.value = '';
  }
}

async function saveWhenReady() {
  if (!pendingLink || !pendingKey) return;
  try {
    Drive.fileIdOf(pendingLink);
    Drive.parseKey(pendingKey);
    await chrome.storage.local.set({ [CONFIG_KEY]: { link: pendingLink, keyText: pendingKey } });
    showError('');
    await chrome.runtime.sendMessage({ type: 'driveSync' }).catch(() => {});
    $('fileStatus').textContent = 'Both files loaded and saved.';
    renderSaved();
  } catch (e) {
    showError(e.message || String(e));
  }
}

$('driveLinkFile').addEventListener('change', async () => {
  const result = await readFile($('driveLinkFile'), Drive.linkFromConfig);
  if (!result) return;
  pendingLink = result.value;
  showError('');
  $('fileStatus').textContent = `${result.name} loaded. Select service-account.json.`;
  await saveWhenReady();
});

$('driveKeyFile').addEventListener('change', async () => {
  const result = await readFile($('driveKeyFile'), (text) => { Drive.parseKey(text); return text; });
  if (!result) return;
  pendingKey = result.value;
  showError('');
  $('fileStatus').textContent = `${result.name} loaded. Select google-drive.json.`;
  await saveWhenReady();
});

$('setupClearBtn').addEventListener('click', async () => {
  await chrome.storage.local.remove([CONFIG_KEY, 'yousubDrive']);
  pendingLink = '';
  pendingKey = '';
  $('fileStatus').textContent = FILE_HINT;
  showError('');
  renderSaved();
});
