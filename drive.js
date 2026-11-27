/*
 * Sync the unsubscribe history to Google Drive (YOUSUB.DRIVE_FILE) with the user's own Google
 * account (OAuth 2.0). Loaded by the service worker (background.js).
 *
 * This is a browser-extension-only project: there is no CLI, native messaging host, or
 * configuration file outside the extension. The configuration is one JSON file the user picks once
 * in the side panel (see config-file.js); its contents are cached in
 * chrome.storage.local.yousubDriveConfig as { clientId, clientSecret, link } and used from there.
 *
 * Authentication is Google OAuth 2.0 through chrome.identity.launchWebAuthFlow, with a
 * "Web application" client and the redirect https://<extension-id>.chromiumapp.org/ (the only
 * redirect a browser catches without a server). Two modes, chosen by whether the configuration
 * carries a client_secret:
 *
 *   - with a secret: authorization code + PKCE, and a refresh token. The sync keeps working in the
 *     background after the browser (or the Google session) went idle.
 *   - without one: the implicit flow, and the access token lives in memory for about an hour.
 *     Google is asked silently first (prompt=none) and only asks the person when it must.
 *
 * Scope: the full Drive scope is required. YouTube.json is a file the user created, and the narrow
 * drive.file scope only sees files the app itself created — an existing file answers 404 there. The
 * narrowing is the file link in the configuration, not the scope.
 *
 * Only a FILE LINK is used: upload YouTube.json to your own Drive, share it with the OAuth client
 * (the account you signed in with must be able to edit it), and paste its file link.
 *
 * Local data (chrome.storage.local.yousubUnsubs):
 *   { [channelId]: { s: 'unsub' | 'resub', at: timestamp, title, url } }
 * Cross-device merge: the most recent event wins for each channel.
 * Only the English Drive file format is read and written.
 */
// eslint-disable-next-line no-unused-vars
var Drive = (() => {
  const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
  const TOKEN_URL = 'https://oauth2.googleapis.com/token';
  const API = 'https://www.googleapis.com/drive/v3/files';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
  const USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';
  const SCOPE = 'https://www.googleapis.com/auth/drive';
  const RESUB_KEEP_MS = 180 * 864e5; // Keep resubscribe events for 180 days so cross-device syncing remains correct

  /* ---------------- configuration entered in the popup ---------------- */
  const SETTINGS = 'The configuration file';
  // The panel has one control that matters here: the folder button, which opens the
  // picker and is also what starts a sign-in. Messages point at it, never at a field that no longer
  // exists — the client ID and secret live in the configuration file.
  const OPEN_FORM = 'Open the side panel and click the folder button.';
  const SIGN_IN = 'Open the side panel, click the folder button, and pick the file again to sign in.';
  const RESET =
    'To get a new one: Google Cloud Console → APIs & Services → Credentials → your OAuth client → ' +
    'Client secrets.';
  const REPLACE_FILE = 'Put it in the configuration file, then pick that file again with the folder button.';

  /** Read a direct YouTube.json file link from a configuration object. */
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
  function fileIdOf(v, source = 'the configuration file') {
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

  /**
   * The cached configuration, read from local storage on every sync. It is written once, when the
   * user picks the configuration file, and survives restarting the browser.
   */
  async function loadConfig() {
    const { [YOUSUB.CONFIG_KEY]: saved = {} } = /** @type {any} */ (await chrome.storage.local.get(YOUSUB.CONFIG_KEY));
    const link = String(saved.link || '').trim();
    const clientId = String(saved.clientId || '').trim();
    const clientSecret = typeof saved.clientSecret === 'string' ? saved.clientSecret.trim() : '';
    if (!link && !clientId) return { disabled: true };
    const fileId = link ? fileIdOf(link) : '';
    // An absent client ID means unconfigured; never start a flow without one.
    if (!clientId) return fileId ? { missingKey: true } : { disabled: true };
    const id = clientIdOf(clientId);
    if (!fileId) return { missingLink: true, clientId: id };
    return { clientId: id, clientSecret, fileId };
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
        : `The Google sign-in window could not be opened (${e?.message || 'unknown error'}). Check your internet connection.`, { cause: e });
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
        return 'The Google account did not grant access. Yousub needs permission to see, edit, create ' +
          'and delete your Google Drive files — it only touches the one file named in the configuration. ' +
          'Grant it on the consent screen, or remove Yousub at https://myaccount.google.com/permissions and sign in again.';
      default:
        return `Google refused the sign-in (${code}${description ? `: ${description}` : ''}).`;
    }
  }

  /** Exchange the code (with the PKCE verifier and the client secret) for tokens. */
  async function exchange(clientId, clientSecret, code) {
    const { [FLOW_KEY]: flow } = /** @type {any} */ (await chrome.storage.session.get(FLOW_KEY));
    await chrome.storage.session.remove(FLOW_KEY);
    if (!flow?.verifier) throw new Error(`The sign-in attempt expired. ${SIGN_IN}`);
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
        throw new Error(`Google requires the OAuth client secret as well. Add "client_secret" in the configuration file (Google Cloud Console → Credentials → your OAuth client). ${RESET} ${REPLACE_FILE}`);
      }
      if (/invalid_client|unauthorized_client/i.test(detail)) {
        throw new Error(`The OAuth client ID or secret is wrong or has been deleted. ${RESET}`);
      }
      if (/invalid_grant/i.test(detail)) {
        throw new Error(`The sign-in code expired or was already used. ${SIGN_IN}`);
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
        throw Object.assign(new Error(`The Google sign-in has expired or was revoked. ${SIGN_IN}`), { code: 'SIGNED_OUT' });
      }
      throw new Error(`Google would not renew the sign-in (${detail || res.status}). Try again later.`);
    }
    return { access: j.access_token, exp: Date.now() + ((j.expires_in || 3600) - 120) * 1000 };
  }

  const FLOW_KEY = 'yousubOAuthFlow';
  const TOKENS_KEY = 'yousubOAuthTokens';
  // The sign-in record is written to disk through TOKENS_KEY; this is the short-lived mirror that
  // lets onInstalled put back a record that an earlier build deleted (see restoreSignIn below).
  const TOKENS_BACKUP_KEY = 'yousubOAuthTokensBackup';
  const NO_REFRESH =
    'Google did not issue a refresh token, so the sign-in cannot renew itself. Remove Yousub at ' +
    'https://myaccount.google.com/permissions, then sign in again.';

  /* ---------------- implicit flow (no client secret) ---------------- */

  /** Tokens from the implicit flow live in memory only: nothing is written to storage. */
  const memory = new Map(); // clientId -> { access, exp }

  function cachedAccess(clientId) {
    const entry = memory.get(clientId);
    if (!entry) return '';
    if (entry.exp <= Date.now()) { memory.delete(clientId); return ''; }
    return entry.access;
  }

  /** Read Google's answer: the token arrives in the fragment, a refusal usually in the query. */
  function readRedirect(redirectUrl, expectedState) {
    const url = new URL(redirectUrl);
    const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));
    const query = url.searchParams;
    const state = fragment.get('state') || query.get('state') || '';
    if (expectedState && state !== expectedState) throw new Error('The sign-in response did not match this request. Try signing in again.');
    const failure = fragment.get('error') || query.get('error');
    if (failure) {
      throw new Error(authError(failure, fragment.get('error_description') || query.get('error_description'), ''));
    }
    const access = fragment.get('access_token') || query.get('access_token') || '';
    if (!access) throw new Error('Google did not return an access token. Try signing in again.');
    return { access, expiresIn: Number(fragment.get('expires_in') || query.get('expires_in')) || 3600 };
  }

  /** One trip through Chrome's sign-in window; interactive=false never shows a page. */
  async function implicitFlow(clientId, interactive) {
    const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri(),
      response_type: 'token',
      scope: SCOPE,
      state,
      // A silent request only works while the person already granted access, which is exactly
      // when no page is wanted.
      prompt: interactive ? 'select_account' : 'none'
    }).toString();
    let redirect;
    try {
      redirect = await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive });
    } catch (e) {
      throw new Error(interactive
        ? `The Google sign-in window could not be opened (${e?.message || 'unknown error'}).`
        : `Yousub is not signed in to Google in this browser. ${SIGN_IN}`, { cause: e });
    }
    if (!redirect) {
      throw new Error(interactive ? 'Google returned no answer.'
        : `Yousub is not signed in to Google in this browser. ${SIGN_IN}`);
    }
    const parsed = readRedirect(redirect, state);
    memory.set(clientId, { access: parsed.access, exp: Date.now() + Math.max(60, parsed.expiresIn - 60) * 1000 });
    return parsed.access;
  }

  /**
   * Return a valid access token, signing in only when there is no other way.
   * interactive=false never opens a window: it fails instead, so no background sync can surprise
   * the user with a consent page.
   * Which flow is used follows the configuration: a client secret allows the code flow with a
   * refresh token, without one the implicit flow keeps the token in memory.
   */
  async function token(cfg, { interactive = false } = {}) {
    const coded = !!cfg.clientSecret;
    if (!coded) {
      // Implicit: memory first, then a silent request, then (when allowed) the consent page.
      const cached = cachedAccess(cfg.clientId);
      if (cached) return cached;
      try {
        return await implicitFlow(cfg.clientId, false);
      } catch (e) {
        if (!interactive) throw Object.assign(e, { code: 'SIGNED_OUT' });
        // Google refused silently: fall through to the page, which is what the click asked for.
      }
      return implicitFlow(cfg.clientId, true);
    }
    const { [TOKENS_KEY]: saved = {} } = /** @type {any} */ (await chrome.storage.local.get(TOKENS_KEY));
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
      throw Object.assign(new Error(`Google Drive sync is not signed in. ${SIGN_IN}`), { code: 'SIGNED_OUT' });
    }
    const code = await authorize(cfg.clientId);
    const next = await exchange(cfg.clientId, cfg.clientSecret, code);
    if (!next.refresh) throw new Error(NO_REFRESH);
    const email = await accountEmail(next.access).catch(() => '');
    await saveTokens({ clientId: cfg.clientId, email, refresh: next.refresh, access: next.access, exp: next.exp });
    return next.access;
  }

  /**
   * Write the sign-in record. It is mirrored into chrome.storage.session, which survives a service
   * worker restart (and an extension update) but not a browser restart: onInstalled runs on every
   * update and deletes local keys it does not know, so the mirror is what lets restoreSignIn put a
   * sign-in back. Nothing new is exposed: chrome.storage.session is readable by this extension only
   * (content scripts included, which is why the record holds tokens and nothing else).
   */
  async function saveTokens(record) {
    await chrome.storage.local.set({ [TOKENS_KEY]: record });
    try {
      // An empty record means there is no sign-in: nothing worth restoring, so no mirror is left.
      if (record.refresh || record.access) await chrome.storage.session.set({ [TOKENS_BACKUP_KEY]: record });
      else await chrome.storage.session.remove(TOKENS_BACKUP_KEY);
    } catch {
      // A browser without chrome.storage.session (before Chrome 102) still syncs; it only loses
      // the ability to repair a record deleted by an update.
    }
  }

  /**
   * Put the sign-in record back after an extension update. A build before 2.7.1 listed neither
   * yousubOAuthTokens in YOUSUB.STORE_KEYS nor a mirror, so the record is often already gone; this
   * makes the recovery automatic when the mirror is still there.
   */
  async function restoreSignIn() {
    try {
      const { [TOKENS_KEY]: saved } = /** @type {any} */ (await chrome.storage.local.get(TOKENS_KEY));
      if (saved && (saved.refresh || saved.access)) return false;
      const { [TOKENS_BACKUP_KEY]: backup } = /** @type {any} */ (await chrome.storage.session.get(TOKENS_BACKUP_KEY));
      if (!backup || !(backup.refresh || backup.access)) return false;
      await chrome.storage.local.set({ [TOKENS_KEY]: backup });
      return true;
    } catch {
      return false;
    }
  }

  /** The signed-in account's address, for the panel. Best effort: the sync works without it. */
  async function accountEmail(access) {
    const res = await fetch(USERINFO, { headers: { Authorization: 'Bearer ' + access } });
    if (!res.ok) return '';
    const j = await res.json().catch(() => ({}));
    return typeof j.email === 'string' ? j.email : '';
  }

  /** Whether a sign-in is remembered on this device (no network call). */
  async function signedIn() {
    const { [TOKENS_KEY]: saved = {} } = /** @type {any} */ (await chrome.storage.local.get(TOKENS_KEY));
    if (saved.refresh || (saved.access && Date.now() < (saved.exp || 0))) return true;
    return memory.size > 0;
  }

  /* ---------------- Drive API ---------------- */

  /**
   * Bound the response and its body. Some connections otherwise leave the panel on "Syncing…"
   * for ever; aborting also releases the socket.
   */
  async function withTimeout(run, timeoutMs = 20000) {
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Google did not answer within 20 seconds. Check your connection and try again.'));
      }, timeoutMs);
    });
    try {
      return await Promise.race([run(controller.signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function call(cfg, url, opts = {}) {
    const access = await token(cfg);
    const res = await withTimeout((signal) => fetch(url, {
      ...opts, signal, headers: { ...opts.headers, Authorization: 'Bearer ' + access }
    }));
    if (res.ok) return res;
    const body = await res.text().catch(() => '');
    if (/SERVICE_DISABLED|accessNotConfigured|has not been used/i.test(body)) {
      throw new Error('The Google Drive API is not enabled. Open Google Cloud Console → APIs & Services and enable "Google Drive API".');
    }
    if (res.status === 401) {
      // Drop the rejected token: keeping it would replay the same request on every sync and the
      // advice in the message below would never work.
      await saveTokens({});
      throw Object.assign(new Error(`Google rejected the saved sign-in. ${SIGN_IN}`), { code: 'SIGNED_OUT' });
    }
    if (res.status === 404) throw Object.assign(new Error('File not found.'), { code: 404 });
    if (res.status === 403) {
      throw new Error(`This Google account cannot edit ${YOUSUB.DRIVE_FILE}. Make sure the file belongs to the account you signed in with, or that it was shared with "Editor" access.`);
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
        throw new Error(`The linked file is not available to this Google account. Open the link in the browser while signed in as that account, check that the file still exists, or paste its link again.`, { cause: e });
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
    const { yousubDrive: cur = {} } = /** @type {any} */ (await chrome.storage.local.get('yousubDrive'));
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
          const msg = cfg.missingKey ? `${SETTINGS} needs "client_id" of a Google OAuth client. ${OPEN_FORM}`
            : `${SETTINGS} needs "yousub-file" with the link to ${YOUSUB.DRIVE_FILE} (right-click the file → Share → Copy link). ${OPEN_FORM}`;
          await chrome.storage.local.set({ yousubDrive: { configured: true, syncing: false, email: '', lastError: msg } });
          return { ok: false, error: msg };
        }
        const { clientId, clientSecret, fileId: id } = cfg;
        const { yousubDrive: prev = {}, yousubUnsubs = {} } = /** @type {any} */ (await chrome.storage.local.get(['yousubDrive', 'yousubUnsubs']));
        const { [TOKENS_KEY]: tok = {} } = /** @type {any} */ (await chrome.storage.local.get(TOKENS_KEY));
        const status = { configured: true, email: tok.email || '', fileId: id, mode: clientSecret ? 'refresh token' : 'session',
          fileName: prev.fileId === id ? prev.fileName || '' : '', checked: false };
        try {
          await save({ ...status, syncing: true });
          // Sign-in is only requested when the user asked for it, or when this device already has a
          // saved sign-in that simply needs renewing.
          await token({ clientId, clientSecret }, { interactive: signIn && !(await signedIn()) });
          const { [TOKENS_KEY]: now = {} } = /** @type {any} */ (await chrome.storage.local.get(TOKENS_KEY));
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
          const latest = (/** @type {any} */ (await chrome.storage.local.get('yousubUnsubs'))).yousubUnsubs || {};
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
    signIn: (cfg, options) => token(cfg, { interactive: true, ...options }), signedIn,
    restoreSignIn, redirectUri, authError, fileIdFrom: fileIdOf
  };
})();
