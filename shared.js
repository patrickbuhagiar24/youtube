/*
 * Shared constants. Loaded by the content scripts (MAIN and isolated worlds),
 * the popup, and the service worker.
 */
// eslint-disable-next-line no-unused-vars, no-var
var YOUSUB = Object.freeze({
  DEFAULTS: Object.freeze({
    enabled: true,
    mode: 'highlight', // highlight | badge | dim | only-unsub | hide-unsub
    color: '#ff3d00',
    showSubButton: true,
    sortUnsub: true, // Move videos from unsubscribed channels to the top
    leftColor: '#ffd400', // Outline for previously unsubscribed channels
    autoloadLimit: 250
  }),

  // Card elements to mark
  CARD_SEL: [
    'ytd-rich-item-renderer', 'ytd-video-renderer', 'ytd-compact-video-renderer',
    'ytd-grid-video-renderer', 'ytd-playlist-renderer', 'ytd-compact-playlist-renderer',
    'ytd-channel-renderer', 'ytd-grid-channel-renderer', 'ytd-playlist-video-renderer',
    'ytd-playlist-panel-video-renderer', 'ytd-movie-renderer', 'ytd-compact-movie-renderer',
    'ytd-video-owner-renderer', 'yt-lockup-view-model'
  ].join(','),

  // Autoload before sorting (Home, Search, watch sidebar): stop at this count or when no more items arrive
  AUTOLOAD: Object.freeze({ stallMs: 15000 }),

  // Local storage keys in use (other keys are removed on update)
  STORE_KEYS: Object.freeze(['yousubSubs', 'yousubUnsubs', 'yousubDrive', 'yousubDriveConfig']),

  // Drive settings entered in the popup: { link, keyText } (stored locally, never synced)
  CONFIG_KEY: 'yousubDriveConfig',

  // Google Drive file for the user-confirmed unsubscribe history
  DRIVE_FILE: 'YouTube.json',

  // Subscription list status in plain English
  STATUS: Object.freeze({
    complete: '✅ Complete list',
    merged: '✅ Complete list',
    capped: '⚠️ Incomplete list',
    partial: '⚠️ Incomplete list'
  })
});
