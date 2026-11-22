const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

/**
 * Run the isolated-world content script inside a DOM built from a plain object tree,
 * so the inline button can be placed next to a native Subscribe button.
 */
function harness({ subbed = false, left = false } = {}) {
  const listeners = {};
  const messages = [];
  const pending = new Map();
  let nextId = 0;

  const boxes = { host: null };
  const make = (tag, attrs = {}) => {
    const el = {
      tagName: tag.toUpperCase(), localName: tag, children: [], parentElement: null, style: {},
      attributes: { ...attrs }, listeners: {}, classList: null, disabled: false, textContent: '',
      isConnected: true, hidden: false,
      getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; },
      setAttribute(name, value) { this.attributes[name] = String(value); },
      removeAttribute(name) { delete this.attributes[name]; },
      hasAttribute(name) { return name in this.attributes; },
      toggleAttribute(name, on) { if (on) this.setAttribute(name, ''); else this.removeAttribute(name); },
      appendChild(child) { child.parentElement = this; this.children.push(child); return child; },
      insertBefore(child, ref) {
        child.parentElement = this;
        const at = this.children.indexOf(ref);
        if (at < 0) this.children.push(child); else this.children.splice(at, 0, child);
        return child;
      },
      remove() {
        if (!this.parentElement) return;
        const at = this.parentElement.children.indexOf(this);
        if (at >= 0) this.parentElement.children.splice(at, 1);
        this.parentElement = null;
      },
      contains(node) { for (let n = node; n; n = n.parentElement) if (n === this) return true; return false; },
      querySelector() { return null; }, querySelectorAll() { return []; },
      addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); },
      // Boxes are set by the harness so a test can simulate YouTube layouts (no box = zero width).
      getBoundingClientRect() {
        const box = (String(this.className).includes('yousub-inline-host') && boxes.host) || this.__box;
        if (!box) return { left: 0, top: 0, bottom: 0, width: 0, height: 0 };
        return { ...box, width: box.right - box.left, height: box.bottom - box.top };
      },
      get previousElementSibling() {
        const at = this.parentElement?.children.indexOf(this) ?? -1;
        return at > 0 ? this.parentElement.children[at - 1] : null;
      },
      matches() { return false; }, closest() { return null; },
      getClientRects() { return []; }
    };
    const classes = new Set();
    el.__box = { left: 0, top: 0, right: 100, bottom: 40 };
    if (attrs.className === 'yousub-inline-host' && boxes.host) el.__box = boxes.host;
    el.classList = {
      add(...names) { names.forEach((n) => classes.add(n)); },
      remove(...names) { names.forEach((n) => classes.delete(n)); },
      toggle(name, on) { const want = on ?? !classes.has(name); if (want) classes.add(name); else classes.delete(name); return want; },
      contains: (name) => classes.has(name),
      [Symbol.iterator]: () => classes.values()
    };
    return el;
  };

  // Layout: card > row > [native subscribe button, ...] — this is where the copy belongs.
  const card = make('yt-lockup-view-model', { 'data-yousub-cid': 'UCabcdefghijklmnopqrstuv', 'data-yousub-name': 'Chan' });
  const row = make('div');
  const thumb = make('div');
  const nativeBtn = make('yt-subscribe-button-view-model');
  row.appendChild(nativeBtn);
  card.appendChild(thumb);
  card.appendChild(row);
  // Normalise the harness to a real querySelector for the two selectors the script uses.
  card.querySelector = (sel) => (String(sel).includes('subscribe-button') ? nativeBtn : null);
  card.querySelectorAll = () => [];

  const document = {
    readyState: 'complete', hidden: false,
    documentElement: {
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; }, [Symbol.iterator]: () => [][Symbol.iterator]() },
      style: { setProperty() {} }, addEventListener() {}
    },
    body: make('body'),
    addEventListener(name, fn) { (listeners[name] ||= []).push(fn); },
    querySelectorAll: (sel) => (sel === 'yt-subscribe-button-view-model' ? [nativeBtn] : String(sel).includes('yt-lockup-view-model') ? [card] : []),
    querySelector: () => null,
    createElement: (tag) => make(tag),
    getElementsByTagName: () => [],
    elementFromPoint: () => null, elementsFromPoint: () => []
  };
  document.body.appendChild(card);
  document.documentElement.contains = () => true;

  const chrome = {
    runtime: { onMessage: { addListener() {} }, sendMessage: () => Promise.resolve() },
    storage: {
      sync: { get: async () => ({ yousubSettings: { showSubButton: true } }) },
      local: {
        get: async () => ({
          yousubSubs: { list: subbed ? [{ id: 'UCabcdefghijklmnopqrstuv', title: 'Chan' }] : [], ts: 1 },
          // The yellow state needs Drive sync configured, matching the extension's behavior.
          yousubUnsubs: left ? { UCabcdefghijklmnopqrstuv: { s: 'unsub', at: 2, title: 'Chan', url: '/channel/UCabcdefghijklmnopqrstuv' } } : {},
          yousubDriveConfig: left ? { link: 'https://drive.google.com/file/d/x/view', keyText: '{}' } : {}
        }),
        set: async () => {}
      },
      onChanged: { addListener() {} }
    }
  };
  const setTimeoutStub = (fn, ms) => { const id = ++nextId; pending.set(id, { fn, ms }); return id; };
  const window = {
    postMessage: (data) => messages.push(data),
    addEventListener(name, fn) { (listeners[name] ||= []).push(fn); },
    requestAnimationFrame: (fn) => fn(),
    location: { origin: 'https://www.youtube.com', pathname: '/', search: '' }
  };

  const context = vm.createContext({
    window, document, chrome, location: { origin: 'https://www.youtube.com', pathname: '/', search: '' },
    MutationObserver: class { observe() {} }, HTMLElement: class {}, HTMLButtonElement: class {},
    requestAnimationFrame: (fn) => fn(), setTimeout: setTimeoutStub, clearTimeout() {}, setInterval: () => 0,
    YOUSUB: {
      DEFAULTS: { enabled: true, mode: 'highlight', color: '#ff3d00', showSubButton: true, sortUnsub: false, leftColor: '#ffd400', autoloadLimit: 250 },
      CARD_SEL: 'yt-lockup-view-model', AUTOLOAD: { stallMs: 15000 }, CONFIG_KEY: 'yousubDriveConfig'
    },
    console
  });
  vm.runInContext(fs.readFileSync('content/content.js', 'utf8'), context);
  const flush = () => { for (const { fn } of pending.values()) fn(); pending.clear(); };
  /** Let storage promises resolve and run every scheduled scan. */
  const run = async (rounds = 4) => {
    for (let i = 0; i < rounds; i++) { await new Promise((resolve) => setImmediate(resolve)); flush(); }
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { card, row, thumb, nativeBtn, document, messages, pending, flush, run, __boxes: boxes };
}

test('the copy is placed directly after YouTube\'s own subscribe button', async () => {
  const h = harness();
  await h.run(); // init() resolves storage, then the first scan places the copy
  const host = h.row.children.find((el) => el.className === 'yousub-inline-host');
  assert.ok(host, 'inline host should be appended to the row holding the native button');
  assert.equal(h.row.children.indexOf(host), h.row.children.indexOf(h.nativeBtn) + 1);
  assert.equal(host.children.length, 1);
  assert.match(host.children[0].className, /yousub-inlinebtn/);
  assert.match(host.children[0].className, /yousub-(?!unsub)/);
  assert.equal(host.children[0].getAttribute('aria-label'), 'Subscribe to this channel');
});

test('a subscribed channel gets the blue unsubscribe copy in the same place', async () => {
  const h = harness({ subbed: true });
  await h.run();
  const host = h.row.children.find((el) => el.className === 'yousub-inline-host');
  assert.ok(host);
  assert.match(host.children[0].className, /yousub-unsubbtn/);
  assert.equal(host.children[0].getAttribute('aria-label'), 'Unsubscribe from this channel');
});

test('clicks on the copy never reach YouTube, so the video does not open', async () => {
  const h = harness();
  await h.run();
  const host = h.row.children.find((el) => el.className === 'yousub-inline-host');
  const btn = host.children[0];
  const stopped = [];
  const event = { preventDefault() {}, stopImmediatePropagation() { stopped.push(true); } };
  for (const fn of btn.listeners.click || []) fn(event);
  assert.equal(stopped.length, 1);
  assert.equal(h.messages.some((m) => m.type === 'subscription'), true);
});

test('the copy lands beside YouTube\'s own button element, never inside it', async () => {
  const h = harness();
  await h.run();
  const host = h.row.children.find((el) => String(el.className).includes('yousub-inline-host'));
  assert.ok(host);
  assert.equal(h.nativeBtn.contains(host), false, 'the copy must not be nested inside YouTube\'s button');
  assert.equal(host.previousElementSibling, h.nativeBtn, 'the copy must come right after it');
});

test('a row that would clip the copy is laid out on one line instead', async () => {
  const h = harness();
  // The copy starts at x=90 but the row ends at x=100: YouTube's wrapper would clip it.
  h.__boxes.host = { left: 90, top: 0, right: 120, bottom: 30 };
  await h.run();
  const row = h.row;
  assert.equal(row.classList.contains('yousub-native-row'), true, 'the row must switch to the one-line fallback');
  assert.equal(row.children.indexOf(h.nativeBtn) + 1, row.children.indexOf(h.row.children.find((el) => String(el.className).includes('yousub-inline-host'))));
  // CSS keeps that fallback from clipping the glyph.
  const css = fs.readFileSync('content/content.css', 'utf8');
  assert.match(css, /\.yousub-native-row \{[^}]*overflow: visible !important;/);
  assert.match(css, /\.yousub-native-row \{[^}]*max-height: none !important;/);
});

test('a previously unsubscribed channel is marked yellow only, without any button', async () => {
  const h = harness({ left: true });
  await h.run();
  assert.equal(h.card.getAttribute('data-yousub-state'), 'left');
  assert.equal(h.card.__yousubKind, null);
  assert.equal(h.card.__yousubInlineKind, null);
  assert.equal(h.row.children.some((el) => el.className === 'yousub-inline-host'), false);
  assert.equal(h.thumb.children.length, 0);
  const css = fs.readFileSync('content/content.css', 'utf8');
  assert.match(css, /\[data-yousub-state="left"\] \.yousub-subbtn/);
  assert.match(css, /\[data-yousub-state="left"\] \.yousub-inline-host \{ display: none !important; \}/);
});

test('the copy also appears where YouTube\'s button is outside the video cards', () => {
  const content = fs.readFileSync('content/content.js', 'utf8');
  const main = fs.readFileSync('content/main-world.js', 'utf8');
  // The video owner area and the channel header host YouTube's button but are not cards.
  assert.match(content, /const OWNER_SEL = 'ytd-video-owner-renderer, yt-page-header-renderer'/);
  assert.match(content, /querySelectorAll\(OWNER_SEL\)/);
  // Their state comes from YouTube's own button, so no channel data is needed to place the copy.
  assert.match(content, /function cardSubscribedState/);
  assert.match(content, /typeof data\?\.subscribed === 'boolean'/);
  // A click there resolves the channel from that very button in the page world.
  assert.match(main, /identityLocal/);
  assert.match(main, /function localSubscribeIdentity/);
  assert.match(main, /data-yousub-local/);
  // Nothing is bound to or clicked on that button: it is only read.
  assert.doesNotMatch(main, /nativeButtonClicked|nativeSubscribeClick/);
});

test('the channel header is scanned as one channel, not as a video', () => {
  const main = fs.readFileSync('content/main-world.js', 'utf8');
  // A header has no video ID, so it must not join the ad check or the video map.
  assert.match(main, /const singleChannel = el\.localName === 'yt-page-header-renderer'/);
  // Its own data shape is read first: description links would otherwise be found instead.
  assert.match(main, /function ownerChannel/);
});

test('the stylesheet declares the inline button and its host', () => {
  const css = fs.readFileSync('content/content.css', 'utf8');
  assert.match(css, /\.yousub-inlinebtn \{/);
  assert.match(css, /\.yousub-inline-host/);
  // The +/− strokes are -absolute- inside the button, so the button is the containing block,
  // and neither the glyph nor the button can be blanked or hidden by YouTube's rules.
  const button = css.slice(css.indexOf('.yousub-inlinebtn {'), css.indexOf('.yousub-inlinebtn::before'));
  assert.match(button, /position: relative !important;/);
  assert.match(button, /visibility: visible !important;/);
  assert.match(button, /background: var\(--yousub-color\) !important;/);
  assert.match(css, /\.yousub-inlinebtn::before,\s*\n\.yousub-inlinebtn::after \{[^}]*position: absolute;/);
  assert.match(css, /background: #fff !important;/);
  assert.match(css, /\.yousub-inlinebtn\.yousub-unsubbtn::after \{ display: none; \}/);
});

test('there are no keyboard shortcuts or hotkeys', () => {
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  assert.equal('commands' in manifest, false);
  for (const file of ['content/content.js', 'content/main-world.js', 'popup/popup.js']) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /addEventListener\('key(down|up|press)'|accessKey|KeyboardEvent|event\.key\b/, `${file} must not bind a keyboard shortcut`);
  }
});
