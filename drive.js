/*
 * Sync the unsubscribe history to Google Drive (YOUSUB.DRIVE_FILE) using a service account.
 * Loaded by the service worker (background.js).
 *
 * This is a browser-extension-only project: there is no CLI, native messaging host, or
 * configuration file outside the extension. Settings are entered in the popup and kept
 * in chrome.storage.local.yousubDriveConfig as { link, keyText }.
 *
 * Only a FILE LINK is used: upload YouTube.json to your own Drive, share it with the service account
 * as an Editor, and paste its file link. The extension never creates or searches for files
 * (new service accounts also have no storage quota).
 *
 * Local data (chrome.storage.local.yousubUnsubs):
 *   { [channelId]: { s: 'unsub' | 'resub', at: timestamp, title, url } }
 * Cross-device merge: the most recent event wins for each channel.
 * Only the English Drive file format is read and written.
 */
// eslint-disable-next-line no-unused-vars, no-var
var Drive = (() => {
  const TOKEN_URL = 'https://oauth2.googleapis.com/token';
  const API = 'https://www.googleapis.com/drive/v3/files';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
  const SCOPE = 'https://www.googleapis.com/auth/drive';
  const RESUB_KEEP_MS = 180 * 864e5; // Keep resubscribe events for 180 days so cross-device syncing remains correct

  /* ---------------- configuration entered in the popup ---------------- */
  const SETTINGS = 'the Google Drive settings in the popup';

  /** Read a direct YouTube.json file link from yousub-google-drive.json. */
  function linkFromConfig(text) {
    let value;
    try { value = typeof text === 'string' ? JSON.parse(text) : text; }
    catch { throw new Error('yousub-google-drive.json is not valid JSON.'); }
    const folderError = 'yousub-google-drive.json points to a folder. YOUSUB needs a direct file link to YouTube.json: open the uploaded YouTube.json in Drive, click Share → Copy link, and save {"link": "<file link>"}.';
    const placeholderError = 'yousub-google-drive.json still contains the placeholder link. Replace it with the shared YouTube.json file link.';
    let link = '';
    if (typeof value === 'string') {
      link = value.trim();
    } else if (value && typeof value === 'object') {
      if (value.folder_url || value.folder_id) throw new Error(folderError);
      const candidate = value.link ?? value.file_url ?? value.file_link ?? value.url;
      link = typeof candidate === 'string' ? candidate.trim() : '';
    }
    if (!link) throw new Error('yousub-google-drive.json must contain a "link" field with the shared YouTube.json file link.');
    if (/^[A-Z]+(?:_[A-Z]+)+$/.test(link)) throw new Error(placeholderError);
    if (/\/folders\//.test(link)) throw new Error(folderError);
    return link;
  }

  /** Extract a file ID from a Google Drive file link. '' means no link is configured. */
  function fileIdOf(v, source = SETTINGS) {
    v = String(v || '').trim();
    if (!v || /^[A-Z]+(?:_[A-Z]+)+$/.test(v)) return '';
    if (/\/folders\//.test(v)) {
      throw new Error(`The link in ${source} points to a folder. Use a file link: right-click ${YOUSUB.DRIVE_FILE} → Share → Copy link.`);
    }
    const m = v.match(/\/file\/d\/([\w-]+)/) || v.match(/[?&]id=([\w-]{10,})/) || v.match(/^([\w-]{10,})$/);
    if (m) return m[1];
    throw new Error(`The link in ${source} is not a Google Drive file link. Right-click ${YOUSUB.DRIVE_FILE} → Share → Copy link.`);
  }

  /** Read the saved setup-page settings from local extension storage. Re-read on every sync. */
  async function loadConfig() {
    const { [YOUSUB.CONFIG_KEY]: saved = {} } = await chrome.storage.local.get(YOUSUB.CONFIG_KEY);
    const link = String(saved.link || '').trim();
    const keyText = typeof saved.keyText === 'string' ? saved.keyText.trim() : '';
    if (!link && !keyText) return { disabled: true };
    const fileId = link ? fileIdOf(link) : '';
    // An absent or empty key is unconfigured; never try to authenticate with a placeholder.
    if (!keyText) return fileId ? { missingKey: true } : { disabled: true };
    const key = parseKey(keyText);
    if (!fileId) return { missingLink: true, key };
    return { key, fileId };
  }

  /** Validate a service account JSON key and return only the fields we use. */
  function parseKey(text) {
    let k;
    try { k = typeof text === 'string' ? JSON.parse(text) : text; } catch { throw new Error('The service account key is not valid JSON.'); }
    if (k?.type !== 'service_account' || !k.client_email || !/BEGIN PRIVATE KEY/.test(k.private_key || '')) {
      throw new Error('This is not a service account key. Download a JSON key from Google Cloud → IAM → Service Accounts → Keys.');
    }
    return { client_email: k.client_email, private_key: k.private_key, token_uri: k.token_uri || TOKEN_URL, project_id: k.project_id || '' };
  }

  /* ---------------- service account authentication (JWT RS256) ---------------- */
  let tokenCache = { email: '', token: '', exp: 0 };
  const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const b64urlText = (s) => b64url(new TextEncoder().encode(s));

  async function signingKey(pem) {
    const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
    return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  }

  async function getToken(key) {
    if (tokenCache.email === key.client_email && Date.now() < tokenCache.exp - 60e3) return tokenCache.token;
    const now = Math.floor(Date.now() / 1000);
    const head = b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = b64urlText(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }));
    const sig = b64url(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await signingKey(key.private_key), new TextEncoder().encode(`${head}.${claim}`)));
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` })
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) {
      throw new Error(/invalid_grant|invalid_client|account not found/i.test(JSON.stringify(j))
        ? 'The service account key is invalid or has been revoked. Create a new key, replace it in the chosen folder, then click the extension sync button.'
        : 'Could not sign in to Google with the service account. Check your internet connection.');
    }
    tokenCache = { email: key.client_email, token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
    return j.access_token;
  }

  /* ---------------- Drive API ---------------- */
  async function call(key, url, opts = {}) {
    const res = await fetch(url, { ...opts, headers: { ...opts.headers, Authorization: 'Bearer ' + (await getToken(key)) } });
    if (res.ok) return res;
    const body = await res.text().catch(() => '');
    if (/SERVICE_DISABLED|accessNotConfigured|has not been used/i.test(body)) {
      throw new Error('The Google Drive API is not enabled. Open Google Cloud Console → APIs & Services and enable "Google Drive API".');
    }
    if (/storageQuotaExceeded|do not have storage quota/i.test(body)) {
      throw new Error('The service account has no storage quota.');
    }
    if (res.status === 404) throw Object.assign(new Error('File not found.'), { code: 404 });
    if (res.status === 403) throw new Error(`The service account does not have permission. Share ${YOUSUB.DRIVE_FILE} with it as an "Editor".`);
    throw new Error(`Google Drive rejected the request (status ${res.status}). Try again later.`);
  }

  /** Check that the linked file is accessible, editable, and not a folder or Google document. */
  async function checkFile(key, fileId) {
    let f;
    try {
      f = await (await call(key, `${API}/${fileId}?fields=${encodeURIComponent('id,name,mimeType,trashed,capabilities(canEdit)')}&supportsAllDrives=true`)).json();
    } catch (e) {
      if (e.code === 404) {
        throw new Error(`The linked file has not been shared. In Google Drive, right-click ${YOUSUB.DRIVE_FILE} → Share → add ${key.client_email} as an Editor.`);
      }
      throw e;
    }
    if (f.mimeType === 'application/vnd.google-apps.folder') {
      throw new Error(`The configured link points to a folder. Use a file link: right-click ${YOUSUB.DRIVE_FILE} → Share → Copy link.`);
    }
    if (f.trashed) throw new Error(`${f.name || YOUSUB.DRIVE_FILE} is in Google Drive Trash. Restore the file first.`);
    if (/^application\/vnd\.google-apps\./.test(f.mimeType || '')) {
      throw new Error(`"${f.name}" is a Google document or spreadsheet, not ${YOUSUB.DRIVE_FILE}. Upload a JSON copy of ${YOUSUB.DRIVE_FILE} to your own Drive, then share that file.`);
    }
    if (!f.capabilities?.canEdit) throw new Error(`${f.name || YOUSUB.DRIVE_FILE} is view-only. Change ${key.client_email} to "Editor".`);
    return f;
  }

  const readFile = async (key, id) => (await call(key, `${API}/${id}?alt=media&supportsAllDrives=true`)).text();
  const writeFile = (key, id, text) => call(key, `${UPLOAD}/${id}?uploadType=media&supportsAllDrives=true`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: text
  });

  /* ---------------- file format and merging ---------------- */
  const LABEL = { unsub: 'unsubscribed', resub: 'resubscribed' };

  /** Parse an English-format file into an event map. Empty or invalid JSON is treated as an empty file. */
  function fromFile(text) {
    const out = {};
    let j;
    try { j = JSON.parse(text || '{}'); } catch { return out; }
    for (const c of Array.isArray(j?.channels) ? j.channels : []) {
      const at = Date.parse(c?.date);
      if (!/^UC[\w-]{10,}$/.test(c?.id || '') || !at) continue;
      out[c.id] = { s: c.status === LABEL.resub ? 'resub' : 'unsub', at, title: c.name ?? '', url: c.url ?? '' };
    }
    return out;
  }

  function toFile(events) {
    const rows = Object.entries(events)
      .map(([id, e]) => ({ id, name: e.title || '', url: e.url ? new URL(e.url, 'https://www.youtube.com').href : `https://www.youtube.com/channel/${id}`, status: LABEL[e.s], date: new Date(e.at).toISOString() }))
      .sort((a, b) => (a.status === b.status ? b.date.localeCompare(a.date) : a.status === LABEL.unsub ? -1 : 1));
    return JSON.stringify({
      application: 'YOUSUB',
      description: 'YouTube channels you have unsubscribed from. Updated automatically by the extension; avoid editing this file manually.',
      updatedAt: new Date().toISOString(),
      unsubscribeCount: rows.filter((r) => r.status === LABEL.unsub).length,
      channels: rows
    }, null, 2);
  }

  /** Merge event maps: the most recent event wins for each channel. */
  function merge(...maps) {
    const out = {};
    for (const m of maps) {
      for (const [id, e] of Object.entries(m || {})) {
        const cur = out[id];
        if (!cur || e.at > cur.at) out[id] = { ...e, title: e.title || cur?.title || '', url: e.url || cur?.url || '' };
        else if (!cur.title && e.title) cur.title = e.title;
      }
    }
    const limit = Date.now() - RESUB_KEEP_MS;
    for (const [id, e] of Object.entries(out)) if (e.s === 'resub' && e.at < limit) delete out[id];
    return out;
  }

  const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

  /* ---------------- synchronization ---------------- */
  let running = null;
  const save = async (patch) => {
    const { yousubDrive: cur = {} } = await chrome.storage.local.get('yousubDrive');
    await chrome.storage.local.set({ yousubDrive: { ...cur, ...patch } });
  };

  /** Pull from Drive, merge with local data, and write back if anything changed. */
  function sync() {
    running ||= (async () => {
      try {
        let cfg;
        try { cfg = await loadConfig(); } catch (e) {
          await save({ configured: true, syncing: false, lastError: e.message });
          return { ok: false, error: e.message };
        }
        if (!cfg || cfg.disabled) {
          await chrome.storage.local.set({ yousubDrive: { configured: false } });
          return { ok: false, configured: false };
        }
        if (cfg.missingKey || cfg.missingLink) {
          const msg = cfg.missingKey ? `Paste your service account JSON key into ${SETTINGS}.`
            : `Paste the ${YOUSUB.DRIVE_FILE} file link into ${SETTINGS} (right-click the file → Share → Copy link).`;
          await chrome.storage.local.set({ yousubDrive: { configured: true, syncing: false, email: cfg.key?.client_email || '', lastError: msg } });
          return { ok: false, error: msg };
        }
        const { key, fileId: id } = cfg;
        const { yousubDrive: prev = {}, yousubUnsubs = {} } = await chrome.storage.local.get(['yousubDrive', 'yousubUnsubs']);
        const status = { configured: true, email: key.client_email, fileId: id, fileName: prev.fileId === id ? prev.fileName || '' : '', checked: false };
        try {
          await save({ ...status, syncing: true });
          // Validate once per link (or after a failure); subsequent syncs read and write directly
          if (prev.fileId !== id || prev.email !== key.client_email || !prev.checked || prev.lastError) {
            status.fileName = (await checkFile(key, id)).name || '';
          }
          status.checked = true;
          let text;
          try { text = await readFile(key, id); } catch (e) {
            if (e.code === 404) { status.checked = false; await checkFile(key, id); }
            throw e;
          }
          const remote = fromFile(text);
          const merged = merge(remote, yousubUnsubs);
          if (!same(merged, remote) || !/"channels"/.test(text)) await writeFile(key, id, toFile(merged));
          const latest = (await chrome.storage.local.get('yousubUnsubs')).yousubUnsubs || {};
          const finalMap = merge(merged, latest); // Preserve local changes made while the sync was running
          if (!same(finalMap, latest)) await chrome.storage.local.set({ yousubUnsubs: finalMap });
          Object.assign(status, { lastSync: Date.now(), lastError: '', count: Object.values(finalMap).filter((e) => e.s === 'unsub').length });
          return { ok: true };
        } catch (e) {
          status.lastError = e.message || String(e);
          return { ok: false, error: status.lastError };
        } finally {
          await save({ ...status, syncing: false });
        }
      } finally {
        // Always allow a later sync to re-read user configuration after edits or errors.
        running = null;
      }
    })();
    return running;
  }

  return { parseKey, fileIdOf, linkFromConfig, sync, merge, fromFile, toFile };
})();
