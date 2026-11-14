/*
 * Sinkronisasi daftar channel yang di-unsubscribe ke Google Drive (berkas YTUC.DRIVE_FILE)
 * memakai service account. Dimuat oleh service worker (background.js).
 *
 * Pengaturan dibaca dari FOLDER EKSTENSI (bukan dari halaman pengaturan):
 *   drive-config.json    -> { "link": "<link berkas YouTube.json yang dibagikan>", "serviceAccount": "service-account.json" }
 *   service-account.json -> file kunci JSON yang diunduh dari Google Cloud (boleh juga ditempel langsung di drive-config.json)
 *
 * Hanya LINK BERKAS yang dipakai: pengguna mengunggah YouTube.json ke Drive-nya sendiri, membagikannya
 * ke email service account sebagai Editor, lalu menempel link berkas itu. Ekstensi tidak pernah membuat
 * berkas dan tidak mencari berkas lain (service account baru juga tidak punya kuota penyimpanan).
 *
 * Data lokal (chrome.storage.local.ytucUnsubs):
 *   { [channelId]: { s: 'unsub' | 'resub', at: timestamp, title, url } }
 * Penggabungan antar-perangkat: per channel, kejadian dengan waktu terbaru yang menang.
 */
// eslint-disable-next-line no-unused-vars, no-var
var Drive = (() => {
  const TOKEN_URL = 'https://oauth2.googleapis.com/token';
  const API = 'https://www.googleapis.com/drive/v3/files';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
  const SCOPE = 'https://www.googleapis.com/auth/drive';
  const RESUB_KEEP_MS = 180 * 864e5; // riwayat "subscribe lagi" disimpan 180 hari agar sinkron antar-perangkat tetap benar

  /* ---------------- pengaturan dari folder ekstensi ---------------- */
  const CONFIG_FILE = 'drive-config.json';

  async function readExtFile(name) {
    try {
      const res = await fetch(chrome.runtime.getURL(name));
      return res.ok ? await res.text() : null;
    } catch { return null; } // file tidak ada
  }

  /** Ambil ID berkas dari link berkas Google Drive. '' = link belum diisi. */
  function fileIdOf(v) {
    v = String(v || '').trim();
    if (!v || /^(PASTE|TEMPEL|ISI)/i.test(v)) return '';
    if (/\/folders\//.test(v)) {
      throw new Error(`Link di ${CONFIG_FILE} adalah link folder. Gunakan link berkas: klik kanan ${YTUC.DRIVE_FILE} → Bagikan → Salin link.`);
    }
    const m = v.match(/\/file\/d\/([\w-]+)/) || v.match(/[?&]id=([\w-]{10,})/) || v.match(/^([\w-]{10,})$/);
    if (m) return m[1];
    throw new Error(`Link di ${CONFIG_FILE} bukan link berkas Google Drive. Klik kanan ${YTUC.DRIVE_FILE} → Bagikan → Salin link.`);
  }

  /** Baca drive-config.json + kunci service account. null = Google Drive tidak dipakai. */
  async function loadConfig() {
    const text = await readExtFile(CONFIG_FILE);
    if (text === null) return null;
    let cfg;
    try { cfg = JSON.parse(text); } catch { throw new Error(`${CONFIG_FILE} rusak (format JSON salah). Periksa tanda kutip dan koma.`); }
    const fileId = fileIdOf(cfg.link || cfg.file);
    let sa = cfg.serviceAccount ?? 'service-account.json';
    if (typeof sa === 'string') {
      const keyText = await readExtFile(sa);
      // Belum diisi sama sekali (tanpa link & tanpa kunci) -> Google Drive dianggap tidak dipakai
      if (keyText === null) return fileId ? { missingKey: sa } : null;
      sa = keyText;
    }
    const key = parseKey(sa);
    if (!fileId) return { missingLink: true, key };
    return { key, fileId };
  }

  /** Validasi isi file kunci JSON service account. Mengembalikan objek kunci yang dipakai saja. */
  function parseKey(text) {
    let k;
    try { k = typeof text === 'string' ? JSON.parse(text) : text; } catch { throw new Error('File ini bukan file kunci JSON yang benar.'); }
    if (k?.type !== 'service_account' || !k.client_email || !/BEGIN PRIVATE KEY/.test(k.private_key || '')) {
      throw new Error('File ini bukan kunci service account. Unduh kunci tipe JSON dari Google Cloud → IAM → Service Accounts → Keys.');
    }
    return { client_email: k.client_email, private_key: k.private_key, token_uri: k.token_uri || TOKEN_URL, project_id: k.project_id || '' };
  }

  /* ---------------- autentikasi service account (JWT RS256) ---------------- */
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
        ? 'Kunci service account tidak berlaku (mungkin sudah dihapus). Buat kunci baru, simpan sebagai service-account.json di folder ekstensi, lalu klik Reload di chrome://extensions.'
        : 'Gagal masuk ke Google dengan service account. Periksa koneksi internet.');
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
      throw new Error('Google Drive API belum diaktifkan. Buka Google Cloud Console → APIs & Services → aktifkan "Google Drive API".');
    }
    if (/storageQuotaExceeded|do not have storage quota/i.test(body)) {
      throw new Error('Service account tidak punya kuota penyimpanan.');
    }
    if (res.status === 404) throw Object.assign(new Error('Berkas tidak ditemukan.'), { code: 404 });
    if (res.status === 403) throw new Error(`Service account tidak punya izin. Pastikan ${YTUC.DRIVE_FILE} dibagikan sebagai "Editor".`);
    throw new Error(`Google Drive menolak permintaan (kode ${res.status}). Coba lagi nanti.`);
  }

  /** Periksa berkas dari link: harus bisa diakses, bukan folder/Google Dokumen, dan boleh diubah (Editor). */
  async function checkFile(key, fileId) {
    let f;
    try {
      f = await (await call(key, `${API}/${fileId}?fields=${encodeURIComponent('id,name,mimeType,trashed,capabilities(canEdit)')}&supportsAllDrives=true`)).json();
    } catch (e) {
      if (e.code === 404) {
        throw new Error(`Berkas di link itu belum dibagikan. Di Google Drive, klik kanan ${YTUC.DRIVE_FILE} → Bagikan → tambahkan ${key.client_email} sebagai Editor.`);
      }
      throw e;
    }
    if (f.mimeType === 'application/vnd.google-apps.folder') {
      throw new Error(`Link di ${CONFIG_FILE} adalah link folder. Gunakan link berkas: klik kanan ${YTUC.DRIVE_FILE} → Bagikan → Salin link.`);
    }
    if (f.trashed) throw new Error(`${f.name || YTUC.DRIVE_FILE} ada di Sampah Google Drive. Pulihkan dulu berkasnya.`);
    if (/^application\/vnd\.google-apps\./.test(f.mimeType || '')) {
      throw new Error(`"${f.name}" adalah Google Dokumen/Spreadsheet, bukan berkas ${YTUC.DRIVE_FILE}. Unggah ${YTUC.DRIVE_FILE} dari folder ekstensi, lalu bagikan berkas itu.`);
    }
    if (!f.capabilities?.canEdit) throw new Error(`${f.name || YTUC.DRIVE_FILE} hanya bisa dilihat. Ubah akses ${key.client_email} menjadi "Editor".`);
    return f;
  }

  const readFile = async (key, id) => (await call(key, `${API}/${id}?alt=media&supportsAllDrives=true`)).text();
  const writeFile = (key, id, text) => call(key, `${UPLOAD}/${id}?uploadType=media&supportsAllDrives=true`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: text
  });

  /* ---------------- format berkas & penggabungan ---------------- */
  const LABEL = { unsub: 'unsubscribe', resub: 'subscribe lagi' };

  /** Isi berkas -> peta kejadian. Berkas kosong / rusak dianggap kosong. */
  function fromFile(text) {
    const out = {};
    let j;
    try { j = JSON.parse(text || '{}'); } catch { return out; }
    for (const c of Array.isArray(j?.channels) ? j.channels : []) {
      const at = Date.parse(c?.tanggal);
      if (!/^UC[\w-]{10,}$/.test(c?.id || '') || !at) continue;
      out[c.id] = { s: c.status === LABEL.resub ? 'resub' : 'unsub', at, title: c.nama || '', url: c.link || '' };
    }
    return out;
  }

  function toFile(events) {
    const rows = Object.entries(events)
      .map(([id, e]) => ({ id, nama: e.title || '', link: e.url ? new URL(e.url, 'https://www.youtube.com').href : `https://www.youtube.com/channel/${id}`, status: LABEL[e.s], tanggal: new Date(e.at).toISOString() }))
      .sort((a, b) => (a.status === b.status ? b.tanggal.localeCompare(a.tanggal) : a.status === LABEL.unsub ? -1 : 1));
    return JSON.stringify({
      aplikasi: 'YT Unsub Detector',
      keterangan: 'Daftar channel YouTube yang sudah di-unsubscribe. Diperbarui otomatis oleh ekstensi; sebaiknya jangan diubah manual.',
      diperbarui: new Date().toISOString(),
      jumlah_unsubscribe: rows.filter((r) => r.status === LABEL.unsub).length,
      channels: rows
    }, null, 2);
  }

  /** Gabungkan beberapa peta kejadian: per channel, kejadian terbaru yang menang. */
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

  /* ---------------- sinkronisasi ---------------- */
  let running = null;
  const save = async (patch) => {
    const { ytucDrive: cur = {} } = await chrome.storage.local.get('ytucDrive');
    await chrome.storage.local.set({ ytucDrive: { ...cur, ...patch } });
  };

  /** Tarik isi Drive, gabungkan dengan data lokal, tulis balik bila berbeda. */
  function sync() {
    running ||= (async () => {
      let cfg;
      try { cfg = await loadConfig(); } catch (e) {
        await save({ configured: true, syncing: false, lastError: e.message });
        return { ok: false, error: e.message };
      }
      if (!cfg) { await chrome.storage.local.set({ ytucDrive: { configured: false } }); return { ok: false, configured: false }; }
      if (cfg.missingKey || cfg.missingLink) {
        const msg = cfg.missingKey ? `File kunci "${cfg.missingKey}" belum ada di folder ekstensi.`
          : `Tempel link berkas ${YTUC.DRIVE_FILE} di ${CONFIG_FILE} (klik kanan berkas → Bagikan → Salin link).`;
        await chrome.storage.local.set({ ytucDrive: { configured: true, syncing: false, email: cfg.key?.client_email || '', lastError: msg } });
        return { ok: false, error: msg };
      }
      const { key, fileId: id } = cfg;
      const { ytucDrive: prev = {}, ytucUnsubs = {} } = await chrome.storage.local.get(['ytucDrive', 'ytucUnsubs']);
      const status = { configured: true, email: key.client_email, fileId: id, fileName: prev.fileId === id ? prev.fileName || '' : '', checked: false };
      try {
        await save({ ...status, syncing: true });
        // Berkas dicek sekali per link (atau bila sebelumnya gagal); setelah itu langsung dibaca/ditulis
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
        const merged = merge(remote, ytucUnsubs);
        if (!same(merged, remote) || !/"channels"/.test(text)) await writeFile(key, id, toFile(merged));
        const latest = (await chrome.storage.local.get('ytucUnsubs')).ytucUnsubs || {};
        const finalMap = merge(merged, latest); // perubahan lokal yang terjadi selama sinkron tetap dipakai
        if (!same(finalMap, latest)) await chrome.storage.local.set({ ytucUnsubs: finalMap });
        Object.assign(status, { lastSync: Date.now(), lastError: '', count: Object.values(finalMap).filter((e) => e.s === 'unsub').length });
        return { ok: true };
      } catch (e) {
        status.lastError = e.message || String(e);
        return { ok: false, error: status.lastError };
      } finally {
        await save({ ...status, syncing: false });
        running = null;
      }
    })();
    return running;
  }

  return { parseKey, fileIdOf, sync, merge, fromFile, toFile };
})();
