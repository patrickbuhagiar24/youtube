/*
 * Load the Google Drive configuration from a FOLDER.
 *
 * The folder is chosen once with the side panel's folder picker; the files inside it are found by
 * their content, not by a list of names in a manifest:
 *   - the service account key: a JSON object with "type": "service_account"
 *   - the Drive settings: a JSON object with a "link" (or file_url / file_link / url) field
 * Only JSON files are read, sub-folders are searched a few levels deep, and the first file that
 * matches each role wins (files whose names are the documented ones are preferred).
 *
 * The folder handle is remembered in IndexedDB, so the same folder can be re-read later without a
 * second pick: the browser asks for permission again only when it has expired.
 */
// eslint-disable-next-line no-unused-vars, no-var
var YousubFolder = (() => {
  const LIMIT = 256 * 1024; // Maximum size of one configuration file
  const MAX_FILES = 200; // Stop scanning a huge folder
  const MAX_DEPTH = 3;

  /** Roles, in the order they are tried when the names are not the documented ones. */
  const KEY_ROLE = 'service-account';
  const DRIVE_ROLE = 'drive';

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
   * Every JSON file in the folder and its sub-folders, as { name, path, text }.
   * Inaccessible or unreadable entries are skipped: one bad file must not stop the scan.
   */
  async function collect(dir, depth = 0, out = [], prefix = '') {
    if (!dir || depth > MAX_DEPTH) return out;
    let entries;
    try { entries = []; for await (const entry of dir.values()) entries.push(entry); } catch { return out; }
    // Documented names first, then the rest alphabetically, so the result does not depend on order
    entries.sort((a, b) => Number(b.name === 'service-account.json') - Number(a.name === 'service-account.json') ||
      Number(b.name === 'yousub-google-drive.json') - Number(a.name === 'yousub-google-drive.json') ||
      a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return out;
      if (entry.kind === 'directory') {
        await collect(entry, depth + 1, out, `${prefix}${entry.name}/`);
        continue;
      }
      if (!/\.json$/i.test(entry.name || '') || entry.kind !== 'file') continue;
      try {
        const file = await entry.getFile();
        if (file.size > LIMIT) continue; // Too large to be a configuration file
        out.push({ name: entry.name, path: `${prefix}${entry.name}`, text: await file.text() });
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
    if (!files.length) throw new Error('No JSON files were found in this folder. Put service-account.json and yousub-google-drive.json in it.');
    const key = choose(files, KEY_ROLE, 'service-account.json');
    const drive = choose(files, DRIVE_ROLE, 'yousub-google-drive.json');
    const missing = [!key && 'service-account.json (the service account key)', !drive && 'yousub-google-drive.json ({"link": "..."})'].filter(Boolean);
    if (missing.length) throw new Error(`This folder does not contain ${missing.join(' or ')}.`);
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

  /** Ask for permission to re-read the remembered folder, without showing a picker. */
  async function usable(handle) {
    if (!handle?.queryPermission) return false;
    const opts = { mode: 'read' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    return (await handle.requestPermission(opts)) === 'granted';
  }

  async function forget() { await stored(null); }

  return { parse, collect, read, remembered, usable, remember: stored, forget, LIMIT };
})();
