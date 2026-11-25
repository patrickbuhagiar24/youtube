/*
 * Load the configuration from ONE file the user picks in the side panel.
 *
 * The file is chosen once with the file picker; its contents are then cached in
 * chrome.storage.local, which survives a browser restart. The panel and the service worker read
 * that cache from then on, so the file is never opened again — not on the next panel open, not
 * after quitting the browser. The file is a source of configuration, never its storage.
 *
 * Format — three keys, of which the last is optional:
 *   {
 *     "yousub-file": "<link to YouTube.json in your Drive>",
 *     "client_id": "<OAuth client id, type Web application>",
 *     "client_secret": "<the client's secret; optional>"
 *   }
 *
 * With a client_secret the extension can keep a refresh token and sync in the background; without
 * one it signs in through Google's implicit flow, which needs your Google session in this browser.
 *
 * Any file name works (`yousub-config.json`, `drive.json`, …): what makes a file a configuration is
 * these keys. The name is only reported back, so the panel can say which file is in use.
 */
// eslint-disable-next-line no-unused-vars, no-var
var YousubConfigFile = (() => {
  const LIMIT = 256 * 1024; // Maximum size of the configuration file
  const LINK_KEY = 'yousub-file';
  const CLIENT_KEY = 'client_id';
  const SECRET_KEY = 'client_secret';
  const FILE = 'The configuration file';
  const VERSION = 1; // Cached shape; another version asks for the file again

  /** A Drive file link (or a bare id) reduced to the file id; '' when it is not one. */
  function fileIdOf(link) {
    const value = String(link || '').trim();
    if (!value) return '';
    const match = value.match(/\/file\/d\/([\w-]+)/) || value.match(/[?&]id=([\w-]{10,})/) || value.match(/^([\w-]{10,})$/);
    return match ? match[1] : '';
  }

  /**
   * Every problem in the file, named one by one, so a single pass is enough to fix them all:
   * a user who has to pick the file again after each error is being told one problem at a time.
   */
  function problems(record) {
    const list = [];
    const link = typeof record?.[LINK_KEY] === 'string' ? record[LINK_KEY].trim() : '';
    const clientId = typeof record?.[CLIENT_KEY] === 'string' ? record[CLIENT_KEY].trim() : '';
    const secret = typeof record?.[SECRET_KEY] === 'string' ? record[SECRET_KEY].trim() : '';

    if (!(LINK_KEY in (record || {}))) list.push(`${FILE} needs "${LINK_KEY}" with the link to ${'YouTube.json'}`);
    else if (!link) list.push(`"${LINK_KEY}" is empty: paste the link to YouTube.json`);
    else if (/\/folders\//.test(link)) list.push(`"${LINK_KEY}" points to a folder: open YouTube.json in Drive, then Share → Copy link`);
    else if (!fileIdOf(link)) list.push(`"${LINK_KEY}" is not a Google Drive file link: right-click YouTube.json → Share → Copy link`);

    if (!(CLIENT_KEY in (record || {}))) list.push(`${FILE} needs "${CLIENT_KEY}" of a Google OAuth client`);
    else if (!clientId) list.push(`"${CLIENT_KEY}" is empty: paste the OAuth client id from Google Cloud Console`);
    else if (!/^\d{6,}-[\w-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
      list.push(`"${CLIENT_KEY}" must look like 1234567890-abc.apps.googleusercontent.com (a Web application client)`);
    }
    // The secret is optional, but a placeholder or a truncated paste is called out.
    if (SECRET_KEY in (record || {}) && secret && secret.length < 10) list.push(`"${SECRET_KEY}" looks incomplete: copy it again from Google Cloud Console`);
    return { list, link, clientId, secret };
  }

  /**
   * Validate a parsed configuration and return what the extension caches.
   * Throws one error that names every problem found, never only the first.
   */
  function validate(record) {
    const { list, link, clientId, secret } = problems(record);
    if (list.length) throw new Error(list.join('; ') + '.');
    return { link, clientId, clientSecret: secret };
  }

  /** Read a File (or anything with .text()/.size) and validate it; the name is carried along. */
  async function read(file) {
    if (!file) throw new Error('No file was chosen.');
    const name = file.name || 'This file';
    if (typeof file.size === 'number' && file.size > LIMIT) {
      throw new Error(`${name} is too large: a configuration file is a few lines (maximum 256 KB).`);
    }
    const text = await file.text();
    if (text.length > LIMIT) throw new Error(`${name} is too large (maximum 256 KB).`);
    let record;
    try {
      record = JSON.parse(String(text || '').replace(/^\uFEFF/, ''));
    } catch {
      throw new Error(`${name} is not valid JSON.`);
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error(`${name} must contain a JSON object with "${LINK_KEY}" and "${CLIENT_KEY}".`);
    }
    const config = validate(record);
    return { ...config, file: file.name || '', savedAt: new Date().toISOString(), version: VERSION };
  }

  /**
   * Whether a cached record can be used as it is. The cache is the source of truth once the file has
   * been read; a record from an older shape (or a damaged one) asks for the file again.
   */
  function usable(record) {
    if (!record || record.version !== VERSION) return false;
    return !!(record.clientId && record.link);
  }

  /** A short, human description of the cached configuration for the panel. */
  function describe(record) {
    if (!usable(record)) return { configured: false };
    return {
      configured: true,
      file: record.file || '',
      clientId: record.clientId,
      hasSecret: !!record.clientSecret,
      savedAt: record.savedAt || ''
    };
  }

  return { read, validate, problems, fileIdOf, usable, describe, LIMIT, LINK_KEY, CLIENT_KEY, SECRET_KEY, VERSION };
})();
