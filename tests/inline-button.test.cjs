const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

/**
 * Run the isolated-world content script inside a DOM built from a plain object tree,
 * so the inline button can be placed next to a native Subscribe button.
 */
function harness({ html = '', subbed = false } = {}) {
  const listeners = {};
  const messages = [];
  const pending = new Map();
  let nextId = 0;

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
      getBoundingClientRect() { return { left: 0, top: 0, bottom: 0, width: 0, height: 0 }; },
      matches() { return false; }, closest() { return null; },
      getClientRects() { return []; }
    };
    const classes = new Set();
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
      local: { get: async () => ({ yousubSubs: { list: subbed ? [{ id: 'UCabcdefghijklmnopqrstuv', title: 'Chan' }] : [], ts: 1 } }), set: async () => {} },
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
    YousubNativeRefresh: { create: () => ({ request() {}, confirm() {}, buttonChanged() {} }) },
    console
  });
  vm.runInContext(fs.readFileSync('content/content.js', 'utf8'), context);
  const flush = () => { for (const { fn } of pending.values()) fn(); pending.clear(); };
  /** Let storage promises resolve and run every scheduled scan. */
  const run = async (rounds = 4) => {
    for (let i = 0; i < rounds; i++) { await new Promise((resolve) => setImmediate(resolve)); flush(); }
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { card, row, thumb, nativeBtn, document, messages, pending, flush, run };
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

test('main-world ignores clicks on the copy when watching for native actions', () => {
  const source = fs.readFileSync('content/main-world.js', 'utf8');
  assert.match(source, /matches\('\.yousub-subbtn, \.yousub-inlinebtn'\)/);
  const css = fs.readFileSync('content/content.css', 'utf8');
  assert.match(css, /\.yousub-inlinebtn \{/);
  assert.match(css, /\.yousub-inline-host/);
});
