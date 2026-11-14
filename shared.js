/*
 * Konstanta bersama. Dimuat oleh: content script (MAIN & isolated world), popup, dan service worker.
 */
// eslint-disable-next-line no-unused-vars, no-var
var YTUC = Object.freeze({
  DEFAULTS: Object.freeze({
    enabled: true,
    mode: 'highlight', // highlight | badge | dim | only-unsub | hide-unsub
    color: '#ff3d00',
    showSubButton: true,
    sortUnsub: true, // urutkan video yang belum di-subscribe ke paling atas
    leftColor: '#ffd400', // bingkai channel yang pernah di-unsubscribe
    autoSyncHours: 6
  }),

  // Elemen kartu yang diberi tanda
  CARD_SEL: [
    'ytd-rich-item-renderer', 'ytd-video-renderer', 'ytd-compact-video-renderer',
    'ytd-grid-video-renderer', 'ytd-playlist-renderer', 'ytd-compact-playlist-renderer',
    'ytd-channel-renderer', 'ytd-grid-channel-renderer', 'ytd-playlist-video-renderer',
    'ytd-playlist-panel-video-renderer', 'ytd-movie-renderer', 'ytd-compact-movie-renderer',
    'ytd-video-owner-renderer', 'yt-lockup-view-model'
  ].join(','),

  // Muat otomatis sebelum diurutkan (Beranda, Pencarian, samping tonton): berhenti di jumlah ini, atau bila tak ada tambahan
  AUTOLOAD: Object.freeze({ limit: 500, stallMs: 15000 }),

  // Kunci penyimpanan lokal yang dipakai (selain ini dibersihkan saat update)
  STORE_KEYS: Object.freeze(['ytucSubs', 'ytucUnsubs', 'ytucDrive']),

  // Berkas Google Drive untuk daftar channel yang di-unsubscribe (dikonfirmasi pengguna)
  DRIVE_FILE: 'YouTube.json',

  // Status daftar subscription (bahasa sederhana)
  STATUS: Object.freeze({
    complete: '✅ Daftar lengkap',
    merged: '✅ Daftar lengkap',
    capped: '⚠️ Daftar belum lengkap',
    partial: '⚠️ Daftar belum lengkap'
  })
});
