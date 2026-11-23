/*
 * Load the Google Drive configuration from a FOLDER.
 *
 * The folder is chosen once with the side panel's folder picker; the files inside it are found by
 * their content, not by a list of names in a manifest:
 *   - the service account key: a JSON object with "type": "service_account"
 *   - the Drive settings: a JSON object with a "link" (or file_url / file_link / url) field
 * Only the files at the top level of the chosen folder are read (sub-folders are not entered), and
 * the first file that matches each role wins (documented file names are preferred).
 *
 * The result is cached in chrome.storage.local, so the folder is read once and the configuration is
 * used from the cache afterwards: no folder access and no permission prompt is needed later. The
 * folder handle is only remembered so the files can be read again after the user picks it.
 */
// eslint-disable-next-line no-unused-vars, no-var
var YousubFolder = (() => {
  const LIMIT = 256 * 1024; // Maximum size of one configuration file
  const MAX_FILES = 200; // Stop scanning a huge folder

  /** Roles, in the order they are tried when the names are not the documented ones. */
  const KEY_ROLE = 'service-account';
  const DRIVE_ROLE = 'drive';
  const MISSING = ['service-account.json', 'yousub-google-drive.json']; // In the order they are reported

  /* ---------------- content checks ---------------- */

  /** A parsed JSON file and the role it can play, or null when it is neither. */
  function roleOf(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (data.type === 'service_account' && typeof data.client_email === 'string' && typeof data.private_key === 'string') {
      return { role: KEY_ROLE, parsed: data };
    }
    const link = [data.link, data.file_url, data.file_link, data.url].find((v) => typeof v === 'string');
    if (typeof link === 'string' && link.trim()) return { role: DRIVE_ROLE, parsed: data };
    return null;
  }

  function parse(text) {
    let data;
    try { data = JSON.parse(String(text || '').replace(/^\uFEFF/, '')); } catch { return null; }
    return roleOf(data) ? { data, ...roleOf(data) } : null;
  }

  /* ---------------- folder walking ---------------- */

  /**
   * Every JSON file at the TOP LEVEL of the folder, as { name, path, text }. Sub-folders are not
   * entered, and unreadable entries are skipped: one bad file must not stop the scan.
   */
  async function collect(dir) {
    const out = [];
    if (!dir) return out;
    let entries;
    try { entries = []; for await (const entry of dir.values()) entries.push(entry); } catch { return out; }
    // Documented names first, then the rest alphabetically, so the result does not depend on order
    entries.sort((a, b) => Number(b.name === 'service-account.json') - Number(a.name === 'service-account.json') ||
      Number(b.name === 'yousub-google-drive.json') - Number(a.name === 'yousub-google-drive.json') ||
      a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= MAX_FILES) break;
      if (entry.kind !== 'file' || !/\.json$/i.test(entry.name || '')) continue;
      try {
        const file = await entry.getFile();
        if (file.size > LIMIT) { out.push({ name: entry.name, path: entry.name, text: '', tooLarge: true }); continue; }
        out.push({ name: entry.name, path: entry.name, text: await file.text() });
      } catch { /* Unreadable file: skip it */ }
    }
    return out;
  }

  /** Pick the first file for a role, preferring the documented file name. */
  function choose(files, role, preferred) {
    const hits = files.map((f) => ({ ...f, ...(parse(f.text) || {}) })).filter((f) => f.role === role);
    return hits.find((f) => f.name === preferred) || hits[0] || null;
  }

  /**
   * Read a folder (any FileSystemDirectoryHandle) and return the Drive configuration.
   * `validate` is called with { link, keyText } so the caller can apply the same rules as before.
   */
  async function read(dir, validate) {
    const files = await collect(dir);
    const key = choose(files, KEY_ROLE, 'service-account.json');
    const drive = choose(files, DRIVE_ROLE, 'yousub-google-drive.json');
    // Name the files that are missing, and say what a present-but-unusable one needs.
    const missing = [];
    if (!key) missing.push('service-account.json');
    if (!drive) missing.push('yousub-google-drive.json');
    if (missing.length) {
      const found = files.length ? `Found instead: ${files.map((f) => f.name).join(', ')}.` : 'No JSON file was found there.';
      const holds = (name) => (name === MISSING[0] ? 'the service account key' : 'the Drive file link ("link" field)');
      const note = missing.length > 1
        ? 'They must hold the service account key and the Drive file link respectively.'
        : `It must hold ${holds(missing[0])}.`;
      throw new Error(`Missing JSON file${missing.length > 1 ? 's' : ''}: ${missing.join(' and ')}. ` +
        `The top level of this folder must contain ${missing.length > 1 ? 'them' : 'it'}, not a sub-folder. ${note} ${found}`);
    }
    const keyText = JSON.stringify(key.data);
    const link = typeof validate === 'function' ? validate(drive.text) : '';
    if (validate?.key) validate.key(keyText);
    return {
      link,
      keyText,
      folder: dir.name || '',
      files: { serviceAccount: key.path, drive: drive.path }
    };
  }

  /* ---------------- remembered folder ---------------- */

  const DB = 'yousub';
  const STORE = 'folders';
  const HANDLE = 'config';

  function db() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function stored(handle) {
    try {
      const conn = await db();
      await new Promise((resolve) => {
        const tx = conn.transaction(STORE, 'readwrite');
        const request = handle ? tx.objectStore(STORE).put(handle, HANDLE) : tx.objectStore(STORE).delete(HANDLE);
        // Remembering the folder is a convenience: never block the configuration on it.
        const done = () => { clearTimeout(timer); conn.close(); resolve(); };
        const timer = setTimeout(done, 2000);
        request.onsuccess = request.onerror = done;
        tx.oncomplete = tx.onerror = done;
      });
    } catch { /* The folder is simply not remembered */ }
  }

  async function remembered() {
    try {
      const conn = await db();
      const handle = await new Promise((resolve) => {
        const req = conn.transaction(STORE, 'readonly').objectStore(STORE).get(HANDLE);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
      conn.close();
      return handle || null;
    } catch { return null; }
  }

  /**
   * Whether the remembered folder can be read again right now. Never calls requestPermission:
   * that needs a user gesture, which opening the panel is not, so the configuration is served from
   * the cache instead and the folder is only read again when the user picks it (📁 / 🔁).
   */
  async function usable(handle) {
    if (!handle?.queryPermission) return false;
    try { return (await handle.queryPermission({ mode: 'read' })) === 'granted'; } catch { return false; }
  }

  async function forget() { await stored(null); }

  return { parse, collect, read, remembered, usable, remember: stored, forget, LIMIT };
})();
