const { CONFIG_KEY } = YOUSUB;
const $ = (id) => document.getElementById(id);
$('ver').textContent = chrome.runtime.getManifest().version;

const LINK_NAME = 'yousub-google-drive.json';
const KEY_NAME = 'service-account.json';
const FILE_HINT = 'Choose the folder containing your YOUSUB configuration files.';
const DB_NAME = 'yousub-config';
const STORE = 'folders';
const HANDLE_KEY = 'setupFolder';

const showError = (message) => {
  $('driveFormError').classList.toggle('hidden', !message);
  $('driveFormError').textContent = message || '';
};

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveFolderHandle(handle) {
  const db = await openDB();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(handle, HANDLE_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

async function loadFolderHandle() {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(HANDLE_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

async function clearFolderHandle() {
  const db = await openDB();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(HANDLE_KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}

async function hasReadPermission(handle) {
  if (!handle.queryPermission) return true;
  const state = await handle.queryPermission({ mode: 'read' });
  if (state === 'granted') return true;
  if (state !== 'prompt' || !handle.requestPermission) return false;
  try { return (await handle.requestPermission({ mode: 'read' })) === 'granted'; }
  catch { return false; }
}

async function findConfigFiles(directory) {
  const files = {};
  let visited = 0;
  async function walk(folder, depth) {
    if (depth > 2 || visited > 300 || (files[LINK_NAME] && files[KEY_NAME])) return;
    for await (const [name, entry] of directory === folder ? folder.entries() : folder.entries()) {
      visited += 1;
      if (visited > 300) return;
      if (entry.kind === 'directory') {
        await walk(entry, depth + 1);
      } else if (entry.kind === 'file' && (name === LINK_NAME || name === KEY_NAME)) {
        files[name] = await entry.getFile();
      }
      if (files[LINK_NAME] && files[KEY_NAME]) return;
    }
  }
  await walk(directory, 0);
  return files;
}

async function saveConfig(linkText, keyText) {
  Drive.fileIdOf(linkText);
  Drive.parseKey(keyText);
  await chrome.storage.local.set({ [CONFIG_KEY]: { link: linkText, keyText } });
  showError('');
  await chrome.runtime.sendMessage({ type: 'driveSync' }).catch(() => {});
  $('fileStatus').textContent = 'Both files loaded and saved.';
  await renderSaved();
}

async function applyFolderFiles(directory) {
  $('folderStatus').textContent = 'Searching the chosen folder…';
  const files = await findConfigFiles(directory);
  if (!files[LINK_NAME] || !files[KEY_NAME]) {
    const missing = [!files[LINK_NAME] && LINK_NAME, !files[KEY_NAME] && KEY_NAME].filter(Boolean).join(' and ');
    $('folderStatus').textContent = `Missing: ${missing}`;
    showError(`Could not find ${missing} in the chosen folder.`);
    return;
  }
  try {
    await saveConfig((await files[LINK_NAME].text()).trim(), (await files[KEY_NAME].text()).trim());
    $('folderStatus').textContent = `Found ${LINK_NAME} and ${KEY_NAME}.`;
  } catch (e) {
    showError(e.message || String(e));
  }
}

$('folderBtn').addEventListener('click', async () => {
  try {
    if (!window.showDirectoryPicker) {
      showError('This Chrome does not support folder access.');
      return;
    }
    const handle = await window.showDirectoryPicker({ id: 'yousub-config', mode: 'read' });
    if (!(await hasReadPermission(handle))) {
      showError('Read permission for the folder was not granted.');
      return;
    }
    await saveFolderHandle(handle);
    showError('');
    await applyFolderFiles(handle);
  } catch (e) {
    if (e?.name !== 'AbortError') showError(e.message || String(e));
  }
});

async function renderSaved() {
  const { [CONFIG_KEY]: cfg = {} } = await chrome.storage.local.get(CONFIG_KEY);
  const saved = !!(String(cfg.link || '').trim() && String(cfg.keyText || '').trim());
  $('setupClearBtn').classList.toggle('hidden', !saved);
  if (saved && $('fileStatus').textContent === FILE_HINT) {
    $('fileStatus').textContent = 'Configuration files are saved in this browser profile. Select new files to replace them.';
  }
}

$('setupClearBtn').addEventListener('click', async () => {
  await chrome.storage.local.remove([CONFIG_KEY, 'yousubDrive', 'yousubUnsubs']);
  await clearFolderHandle();
  $('fileStatus').textContent = FILE_HINT;
  $('folderStatus').textContent = 'No folder selected.';
  showError('');
  await renderSaved();
});

(async () => {
  await renderSaved();
  try {
    const handle = await loadFolderHandle();
    if (!handle) {
      $('folderStatus').textContent = 'No folder selected.';
      return;
    }
    if (await hasReadPermission(handle)) {
      $('folderStatus').textContent = 'Using the saved folder…';
      await applyFolderFiles(handle);
    } else {
      $('folderStatus').textContent = 'Folder access needs to be granted again. Choose it once more.';
    }
  } catch { /* Folder access unavailable; the saved folder can be chosen again. */ }
})();
