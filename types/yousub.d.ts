/*
 * Type-only declarations for the YouTube page internals Yousub reads and the tags the content
 * scripts write. Nothing here is emitted, bundled, or shipped with the extension: the build copies
 * only manifest.json, the scripts, content/, popup/ and icons/.
 */

/** Findings the content script attaches to YouTube's own elements (see content/content.js). */
interface Element {
  __yousubCard?: Element | null;
  __yousubCh?: any;
  __yousubKey?: string;
  __yousubKind?: string;
  __yousubInline?: boolean;
  __yousubInlineKind?: string;
  __yousubSig?: string;
  __yousubLocal?: string;
  __yousubId?: string;
  __yousubName?: string;
  __yousubRowFixed?: boolean;
}

/** The two script worlds, plus the page globals YouTube itself uses. */
interface Window {
  __YOUSUB_CONTENT__?: boolean;
  __YOUSUB_MAIN__?: boolean;
  ytcfg?: any;
  ytInitialData?: any;
  ytInitialPlayerResponse?: any;
  // File System Access API: used by the side panel to pick the configuration file.
  showOpenFilePicker?: (options?: any) => Promise<any[]>;
}

/** Requests YouTube sends through XHR are tagged with their URL (see content/main-world.js). */
interface XMLHttpRequest {
  __yousubUrl?: string;
}

/** The service worker loads shared.js and drive.js with importScripts. */
declare function importScripts(...urls: string[]): void;
