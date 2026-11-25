/*
 * Sync the unsubscribe history to Google Drive (YOUSUB.DRIVE_FILE) with the user's own Google
 * account (OAuth 2.0). Loaded by the service worker (background.js).
 *
 * This is a browser-extension-only project: there is no CLI, native messaging host, or
 * configuration file outside the extension. Settings are entered in the side panel and kept in
 * chrome.storage.local.yousubDriveConfig as { clientId, link }.
 *
 * Authentication: Google's OAuth 2.0 authorization-code flow with PKCE, run through
 * chrome.identity.launchWebAuthFlow with a "Web application" OAuth client. The redirect goes to
 * https://<extension-id>.chromiumapp.org/ (the only redirect a browser catches without a server),
 * which Google only accepts for a Web client. Because such a client also expects its
 * client_secret when redeeming the code, the user pastes the "client secret" next to the client ID
 * once; it stays on this device in local storage. PKCE alone is not enough for Google here: with
 * a bare client_id and no secret the token endpoint answers "client_secret is missing".
 *
 * Scope is drive.file only: Yousub may read and write the ONE file the user shares with it, never
 * the rest of the Drive.
 *
 * Only a FILE LINK is used: upload YouTube.json to your own Drive, share it with the OAuth client
 * (the account you signed in with must be able to edit it), and paste its file link.
 *
 * Local data (chrome.storage.local.yousubUnsubs):
 *   { [channelId]: { s: 'unsub' | 'resub', at: timestamp, title, url } }
 * Cross-device merge: the most recent event wins for each channel.
 * Only the English Drive file format is read and written.
 */
// eslint-disable-next-line no-unused-vars, no-var
var Drive = (() => {
  const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
  const TOKEN_URL = 'https://oauth2.googleapis.com/token';
  const API = 'https://www.googleapis.com/drive/v3/files';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
  const USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const RESUB_KEEP_MS = 180 * 864e5; // Keep resubscribe events for 180 days so cross-device syncing remains correct

  /* ---------------- configuration entered in the popup ---------------- */
  const SETTINGS = 'the Google settings in the side panel';
  const RESET =
    'To get a new one: Google Cloud Console → APIs & Services → Credentials → your OAuth client → ' +
    'Client secrets → Add secret.';

  /** Read a direct YouTube.json file link from yousub-google-drive.json. */
  function linkFromConfig(text) {
    let value;
    try { value = typeof text === 'string' ? JSON.parse(text) : text; }
    catch { throw new Error('yousub-google-drive.json is not valid JSON.'); }
    const folderError = `yousub-google-drive.json points to a folder. Yousub needs a direct file link to ${YOUSUB.DRIVE_FILE}: open the uploaded file in Drive, click Share → Copy link, and save {"link": "<file link>"}.`;
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

  /** A Google OAuth client ID looks like "<number>-<random>.apps.googleusercontent.com". */
  function clientIdOf(v) {
    const id = String(v || '').trim();
    if (!id) return '';
    if (!/^\d{6,}-[\w-]+\.apps\.googleusercontent\.com$/.test(id)) {
      throw new Error('The OAuth client ID must look like 1234567890-abc.apps.googleusercontent.com. Copy it from Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client IDs.');
    }
    return id;
  }

  /** Read the saved settings from local extension storage. Re-read on every sync. */
  async function loadConfig() {
    const { [YOUSUB.CONFIG_KEY]: saved = {} } = await chrome.storage.local.get(YOUSUB.CONFIG_KEY);
    const link = String(saved.link || '').trim();
    const clientId = String(saved.clientId || '').trim();
    const keyText = typeof saved.keyText === 'string' ? saved.keyText.trim() : '';
    if (!link && !clientId) return { disabled: true };
    const fileId = link ? fileIdOf(link) : '';
    // An absent client ID means unconfigured; never start a flow without one.
    if (!clientId) return fileId ? { missingKey: true } : { disabled: true };
    const id = clientIdOf(clientId);
    if (!fileId) return { missingLink: true, clientId: id };
    return { clientId: id, clientSecret: keyText, fileId };
  }

  /* ---------------- authentication: authorization code + PKCE ---------------- */

  const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  /** One-time verifier and its S256 challenge, plus the state that must come back unchanged. */
  async function pkce() {
    const random = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
    const verifier = random(48);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    return { verifier, challenge, state: random(16) };
  }

  /** The redirect URL Chrome intercepts for this extension (must be registered on the OAuth client). */
  function redirectUri() {
    return chrome.identity.getRedirectURL();
  }

  /**
   * Ask the user to sign in and consent, and return the authorization code.
   * The flow is stored in chrome.storage.session: the service worker can be stopped while the
   * consent window is open, and the verifier must survive that.
   */
  async function authorize(clientId) {
    const flow = await pkce();
    await chrome.storage.session.set({ [FLOW_KEY]: flow });
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri(),
      scope: SCOPE,
      access_type: 'offline', // A refresh token, so the sync keeps working after an hour
      prompt: 'consent',
      include_granted_scopes: 'true',
      code_challenge: flow.challenge,
      code_challenge_method: 'S256',
      state: flow.state
    }).toString();
    let redirect;
    try {
      redirect = await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive: true });
    } catch (e) {
      throw new Error(/did not approve|canceled|cancelled|closed/i.test(e?.message || '')
        ? 'Sign-in was cancelled. Nothing was changed.'
        : `The Google sign-in window could not be opened (${e?.message || 'unknown error'}). Check your internet connection.`);
    }
    const params = new URL(redirect).searchParams;
    const error = params.get('error');
    if (error) throw new Error(authError(error, params.get('error_description'), clientId));
    if (params.get('state') !== flow.state) throw new Error('The sign-in response did not match this request. Try signing in again.');
    const code = params.get('code');
    if (!code) throw new Error('Google did not return an authorization code. Try signing in again.');
    return code;
  }

  /** Explain the OAuth errors that come from a misconfigured client. */
  function authError(code, description, clientId) {
    switch (code) {
      case 'redirect_uri_mismatch':
        return `This extension's sign-in address is not registered on the OAuth client. Add ${redirectUri()} to Google Cloud Console → Credentials → your OAuth client → Authorized redirect URIs (exactly, with the trailing slash). The extension ID is only stable while the package from this repository is installed.`;
      case 'invalid_client':
        return `Google does not recognise the OAuth client ID${clientId ? ` (${clientId})` : ''}. Copy the full Client ID from Google Cloud Console → Credentials.`;
      case 'unauthorized_client':
        return 'This OAuth client is not allowed to use this sign-in method. The client type must be "Web application".';
      case 'access_denied':
        return 'The Google account did not grant access. Yousub needs the "See, edit, create and delete only the specific Google Drive files you use with this app" permission to read and write the history file.';
      default:
        return `Google refused the sign-in (${code}${description ? `: ${description}` : ''}).`;
    }
  }

  /** Exchange the code (with the PKCE verifier and the client secret) for tokens. */
  async function exchange(clientId, clientSecret, code) {
    const { [FLOW_KEY]: flow } = await chrome.storage.session.get(FLOW_KEY);
    await chrome.storage.session.remove(FLOW_KEY);
    if (!flow?.verifier) throw new Error('The sign-in attempt expired. Click ⚙️ and sign in again.');
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      client_id: clientId,
      code_verifier: flow.verifier
    });
    // Google's Web clients require the secret at this step; a Chrome-extension client cannot use
    // launchWebAuthFlow at all, so there is no secret-free alternative.
    if (clientSecret) body.set('client_secret', clientSecret);
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) {
      const detail = String(j.error_description || j.error || '');
      if (/client_secret is missing/i.test(detail)) {
        throw new Error(`Google requires the OAuth client secret as well. Paste it in the "Client secret" field (Google Cloud Console → Credentials → your OAuth client). ${RESET}`);
      }
      if (/invalid_client|unauthorized_client/i.test(detail)) {
        throw new Error(`The OAuth client ID or secret is wrong or has been deleted. ${RESET}`);
      }
      if (/invalid_grant/i.test(detail)) {
        throw new Error('The sign-in code expired or was already used. Sign in again.');
      }
      throw new Error(`Google did not return an access token (${detail || res.status}). Try again.`);
    }
    return {
      access: j.access_token,
      refresh: j.refresh_token || '',
      exp: Date.now() + ((j.expires_in || 3600) - 120) * 1000
    };
  }

  /** Ask for a fresh access token from the saved refresh token. */
  async function refreshToken(clientId, clientSecret, refresh) {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: clientId
    });
    if (clientSecret) body.set('client_secret', clientSecret);
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) {
      const detail = String(j.error_description || j.error || '');
      if (/invalid_grant|expired|revoked/i.test(detail)) {
        throw Object.assign(new Error('The Google sign-in has expired or was revoked. Click ⚙️ and sign in again.'), { code: 'SIGNED_OUT' });
      }
      throw new Error(`Google would not renew the sign-in (${detail || res.status}). Try again later.`);
    }
    return { access: j.access_token, exp: Date.now() + ((j.expires_in || 3600) - 120) * 1000 };
  }

  const FLOW_KEY = 'yousubOAuthFlow';
  const TOKENS_KEY = 'yousubOAuthTokens';
  const NO_REFRESH =
    'Google did not issue a refresh token, so the sign-in cannot renew itself. Remove Yousub at ' +
    'https://myaccount.google.com/permissions, then sign in again with "Force re-consent" below.';

  /**
   * Return a valid access token, signing in only when there is no other way.
   * interactive=false never opens a window: it fails instead, so an alarm cannot surprise the user.
   */
  async function token(cfg, { interactive = false } = {}) {
    const { [TOKENS_KEY]: saved = {} } = await chrome.storage.local.get(TOKENS_KEY);
    const mine = saved.clientId === cfg.clientId ? saved : {};
    if (mine.access && Date.now() < (mine.exp || 0)) return mine.access;
    if (mine.refresh) {
      try {
        const next = await refreshToken(cfg.clientId, cfg.clientSecret, mine.refresh);
        await saveTokens({ clientId: cfg.clientId, email: mine.email || '', refresh: mine.refresh, ...next });
        return next.access;
      } catch (e) {
        if (e.code !== 'SIGNED_OUT') throw e;
        await saveTokens({});
        if (!interactive) throw e;
      }
    }
    if (!interactive) {
      throw Object.assign(new Error('Google Drive sync is not signed in. Open the side panel and click ⚙️ to sign in.'), { code: 'SIGNED_OUT' });
    }
    if (!cfg.clientSecret) {
      throw new Error(`Google needs the OAuth client secret to finish signing in. Paste it in the "Client secret" field. ${RESET}`);
    }
    const code = await authorize(cfg.clientId);
    const next = await exchange(cfg.clientId, cfg.clientSecret, code);
    if (!next.refresh) throw new Error(NO_REFRESH);
    const email = await accountEmail(next.access).catch(() => '');
    await saveTokens({ clientId: cfg.clientId, email, refresh: next.refresh, access: next.access, exp: next.exp });
    return next.access;
  }

  const saveTokens = (patch) => chrome.storage.local.set({ [TOKENS_KEY]: patch });

  /** The signed-in account's address, for the panel. Best effort: the sync works without it. */
  async function accountEmail(access) {
    const res = await fetch(USERINFO, { headers: { Authorization: 'Bearer ' + access } });
    if (!res.ok) return '';
    const j = await res.json().catch(() => ({}));
    return typeof j.email === 'string' ? j.email : '';
  }

  /** Forget the tokens and, when possible, revoke them at Google. */
  async function signOut() {
    const { [TOKENS_KEY]: saved = {} } = await chrome.storage.local.get(TOKENS_KEY);
    if (saved.refresh) {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(saved.refresh)}`, { method: 'POST' }).catch(() => {});
    }
    await saveTokens({});
    await chrome.storage.session.remove(FLOW_KEY);
  }

  /** Whether a sign-in exists on this device (no network call). */
  async function signedIn() {
    const { [TOKENS_KEY]: saved = {} } = await chrome.storage.local.get(TOKENS_KEY);
    return !!(saved.refresh || (saved.access && Date.now() < (saved.exp || 0)));
  }

  /* ---------------- Drive API ---------------- */
  async function call(cfg, url, opts = {}) {
    const res = await fetch(url, { ...opts, headers: { ...opts.headers, Authorization: 'Bearer ' + (await token(cfg)) } });
    if (res.ok) return res;
    const body = await res.text().catch(() => '');
    if (/SERVICE_DISABLED|accessNotConfigured|has not been used/i.test(body)) {
      throw new Error('The Google Drive API is not enabled. Open Google Cloud Console → APIs & Services and enable "Google Drive API".');
    }
    if (res.status === 401) {
      throw Object.assign(new Error('Google rejected the saved sign-in. Click ⚙️ and sign in again.'), { code: 'SIGNED_OUT' });
    }
    if (res.status === 404) throw Object.assign(new Error('File not found.'), { code: 404 });
    if (res.status === 403) {
      throw new Error(`This Google account cannot edit ${YOUSUB.DRIVE_FILE}. Share the file with the account you signed in as, with "Editor" access.`);
    }
    throw new Error(`Google Drive rejected the request (status ${res.status}). Try again later.`);
  }

  /** Check that the linked file is accessible, editable, and not a folder or Google document. */
  async function checkFile(cfg, fileId) {
    let f;
    try {
      f = await (await call(cfg, `${API}/${fileId}?fields=${encodeURIComponent('id,name,mimeType,trashed,capabilities(canEdit)')}&supportsAllDrives=true`)).json();
    } catch (e) {
      if (e.code === 404) {
        throw new Error(`The linked file is not available to this Google account. Share ${YOUSUB.DRIVE_FILE} with the account you signed in as (Editor), or paste the link again.`);
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
    if (!f.capabilities?.canEdit) throw new Error(`${f.name || YOUSUB.DRIVE_FILE} is view-only for this Google account. Ask the owner for "Editor" access.`);
    return f;
  }

  const readFile = async (cfg, id) => (await call(cfg, `${API}/${id}?alt=media&supportsAllDrives=true`)).text();
  const writeFile = (cfg, id, text) => call(cfg, `${UPLOAD}/${id}?uploadType=media&supportsAllDrives=true`, {
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
      application: 'Yousub',
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

  /**
   * Pull from Drive, merge with local data, and write back if anything changed.
   * `signIn: true` may open the Google consent window (only from a click in the panel).
   */
  function sync({ signIn = false } = {}) {
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
          const msg = cfg.missingKey ? `Paste your Google OAuth client ID and secret into ${SETTINGS}.`
            : `Paste the ${YOUSUB.DRIVE_FILE} file link into ${SETTINGS} (right-click the file → Share → Copy link).`;
          await chrome.storage.local.set({ yousubDrive: { configured: true, syncing: false, email: '', lastError: msg } });
          return { ok: false, error: msg };
        }
        const { clientId, clientSecret, fileId: id } = cfg;
        const { yousubDrive: prev = {}, yousubUnsubs = {} } = await chrome.storage.local.get(['yousubDrive', 'yousubUnsubs']);
        const { [TOKENS_KEY]: tok = {} } = await chrome.storage.local.get(TOKENS_KEY);
        const status = { configured: true, email: tok.email || '', fileId: id, fileName: prev.fileId === id ? prev.fileName || '' : '', checked: false };
        try {
          await save({ ...status, syncing: true });
          // Sign-in is only requested when the user asked for it, or when this device already has a
          // saved sign-in that simply needs renewing.
          await token({ clientId, clientSecret }, { interactive: signIn && !(await signedIn()) });
          const { [TOKENS_KEY]: now = {} } = await chrome.storage.local.get(TOKENS_KEY);
          status.email = now.email || status.email;
          // Validate once per link (or after a failure); subsequent syncs read and write directly
          if (prev.fileId !== id || prev.email !== status.email || !prev.checked || prev.lastError) {
            status.fileName = (await checkFile(cfg, id)).name || '';
          }
          status.checked = true;
          let text;
          try { text = await readFile(cfg, id); } catch (e) {
            if (e.code === 404) { status.checked = false; await checkFile(cfg, id); }
            throw e;
          }
          const remote = fromFile(text);
          const merged = merge(remote, yousubUnsubs);
          if (!same(merged, remote) || !/"channels"/.test(text)) await writeFile(cfg, id, toFile(merged));
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

  return {
    clientIdOf, fileIdOf, linkFromConfig, sync, merge, fromFile, toFile,
    signIn: (cfg) => token(cfg, { interactive: true }), signOut, signedIn, redirectUri, authError
  };
})();
