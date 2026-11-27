const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

/**
 * Run the isolated-world content script inside a DOM built from a plain object tree,
 * so the inline button can be placed next to a native Subscribe button.
 */
function harness({ subbed = false, left = false, stacked = false, clip = false } = {}) {
  const layout = { stacked, clip };
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
          yousubDriveConfig: left ? { link: 'https://drive.google.com/file/d/x/view', clientId: '1234567890-abc.apps.googleusercontent.com' } : {}
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
    // Every row in this harness is a horizontal flex row, like YouTube's button rows, unless a
    // test declares the row as a stacked container.
    getComputedStyle: () => (layout.stacked
      ? { display: 'flex', flexDirection: 'column', flexWrap: 'nowrap' }
      : { display: 'flex', flexDirection: 'row', flexWrap: 'nowrap' }),
    requestAnimationFrame: (fn) => fn(), setTimeout: setTimeoutStub, clearTimeout() {}, setInterval: () => 0,
    YOUSUB: {
      DEFAULTS: { enabled: true, mode: 'highlight', color: '#ff3d00', showSubButton: true, sortUnsub: false, leftColor: '#ffd400', autoloadLimit: 250 },
      CARD_SEL: 'yt-lockup-view-model', AUTOLOAD: { stallMs: 15000 }, CONFIG_KEY: 'yousubDriveConfig'
    },
    console
  });
  // The filename lets the test runner attribute V8 coverage to the real file.
  vm.runInContext(fs.readFileSync('content/content.js', 'utf8'), context, { filename: path.resolve('content/content.js') });
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
  assert.equal(host.children[0].getAttribute('aria-label'), 'Subscribe');
});

test('a subscribed channel gets the blue unsubscribe copy in the same place', async () => {
  const h = harness({ subbed: true });
  await h.run();
  const host = h.row.children.find((el) => el.className === 'yousub-inline-host');
  assert.ok(host);
  assert.match(host.children[0].className, /yousub-unsubbtn/);
  assert.equal(host.children[0].getAttribute('aria-label'), 'Unsubscribe');
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

test('a row YouTube already lays out on one line is never restyled', async () => {
  const h = harness();
  await h.run();
  assert.equal(h.row.classList.contains('yousub-native-row'), false, 'no layout change when the row is fine');
  // The copy still sits right after the button, and stays there over repeated scans.
  const host = h.row.children.find((el) => String(el.className).includes('yousub-inline-host'));
  assert.equal(host.previousElementSibling, h.nativeBtn);
  const before = h.row.children.slice();
  await h.run(6);
  assert.deepEqual(h.row.children, before, 'the copy must not move between scans');
});

test('a stacked row gets the one-line fallback, and it is stable', async () => {
  const h = harness({ stacked: true });
  await h.run();
  const row = h.row;
  const host = row.children.find((el) => String(el.className).includes('yousub-inline-host'));
  assert.ok(host);
  assert.equal(row.classList.contains('yousub-native-row'), true, 'a column row must be laid out on one line');
  assert.equal(host.previousElementSibling, h.nativeBtn);
  const before = row.children.slice();
  await h.run(6); // Repeated scans must not toggle the class back and forth
  assert.equal(row.classList.contains('yousub-native-row'), true);
  assert.deepEqual(row.children, before);
  // CSS keeps the glyph visible and the button at its own size.
  const css = fs.readFileSync('content/content.css', 'utf8');
  assert.match(css, /\.yousub-native-row \{[^}]*overflow: visible !important;/);
  assert.match(css, /\.yousub-native-row \{[^}]*flex-wrap: nowrap !important;/);
  // The copy itself can never resize the row it was placed in.
  assert.match(css, /\.yousub-inline-host \{[^}]*contain: layout style;/);
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
  // No fixed container list: every native button outside a card gets the copy, whatever wraps it.
  assert.match(content, /for \(const el of \(page \|\| document\)\.querySelectorAll\(NATIVE_SUB_SEL\)\)/);
  assert.doesNotMatch(content, /OWNER_SEL/);
  // A button already handled by the card pass is skipped, so no duplicate copy is placed.
  assert.match(content, /if \(card\?\.__yousubCh \|\| card\?\.hasAttribute\('data-yousub-state'\)\) continue;/);
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

test('the button is tagged before its channel is asked for', () => {
  const content = fs.readFileSync('content/content.js', 'utf8');
  // askLocalId sends the token, so a token generated after the call would resolve the wrong button.
  const tag = content.indexOf("el.__yousubLocal ||= 'l'");
  const ask = content.indexOf('askLocalId(el);');
  assert.ok(tag > 0 && ask > 0 && tag < ask, 'the data-yousub-local tag must exist before the lookup');
  // One lookup per button, and the answer does not trigger another one.
  assert.match(content, /if \(el\.__yousubAsking \|\| !el\.__yousubLocal\) return;/);
});

test('the channel header is scanned as one channel, not as a video', () => {
  const main = fs.readFileSync('content/main-world.js', 'utf8');
  // A header has no video ID, so it must not join the ad check or the video map.
  assert.match(main, /const singleChannel = el\.localName === 'yt-page-header-renderer'/);
  // Its own data shape is read first: description links would otherwise be found instead.
  assert.match(main, /function ownerChannel/);
});

test('a stacked row is detected from its declared layout, not from a moving measurement', () => {
  const content = fs.readFileSync('content/content.js', 'utf8');
  const css = fs.readFileSync('content/content.css', 'utf8');
  // Row direction comes from computed style, so it cannot depend on the copy's own position.
  assert.match(content, /function rowIsHorizontal\(el\)/);
  assert.match(content, /\/column\/\.test\(style\.flexDirection \|\| ''\)/);
  // A row YouTube lays out horizontally is used as is: no restyling, so nothing can move.
  assert.match(content, /const flatRow = horizontalRow\(anchor\);/);
  assert.match(content, /const parent = flatRow \|\| stackedParent\(anchor\);/);
  // The fallback is decided once and remembered, never recomputed after it changes the layout.
  assert.match(content, /if \(!flatRow && !parent\.__yousubRowFixed\) \{/);
  // Never restyle a page-wide container.
  assert.match(content, /function stackedParent\(anchor\)/);
  assert.match(content, /if \(rp\.height && rp\.height > Math\.max\(ra\.height, 30\) \* 3\) return null;/);
  // The fallback class is only ever added, never toggled by a measurement that it itself changes.
  assert.match(css, /\.yousub-native-row \{[^}]*flex-direction: row !important;/);
});

test('a subscribed channel is named exactly as the subscription list names it', () => {
  const content = fs.readFileSync('content/content.js', 'utf8');
  // The rendered card title can be shortened (handle, badges, truncation); the list is exact.
  assert.match(content, /const listed = cid \? subs\.list\.find\(\(c\) => c\.id === cid\) : null;/);
  assert.match(content, /if \(listed\?\.title\) name = listed\.title;/);
});

test('a button outside the cards carries a name, never a raw channel ID', () => {
  const content = fs.readFileSync('content/content.js', 'utf8');
  const main = fs.readFileSync('content/main-world.js', 'utf8');
  // The copy's channel keeps the name from the page world, the list, or what YouTube shows.
  assert.match(content, /el\.__yousubName \|\|= nameNearButton\(el\);/);
  assert.match(content, /function nameNearButton\(el\)/);
  assert.match(content, /el\.__yousubName = info\?\.name \|\| el\.__yousubName \|\| nameNearButton\(el\);/);
  // The page world answers with the channel's name as well as its ID.
  assert.match(main, /function pageChannelName\(id\)/);
  assert.match(main, /fromPlayer\?\.channelId === id && fromPlayer\.author/);
});

test('a card without channel data is resolved from its own button, not sent without an ID', () => {
  const content = fs.readFileSync('content/content.js', 'utf8');
  // The watch page owner area is a card with no channel data of its own: it owns the copy, so it
  // must be marked local - otherwise the click silently sent no channel at all.
  assert.match(content, /if \(!r\.id && nativeSubButton\(card\)\) \{/);
  assert.match(content, /Object\.assign\(r, \{ __local: true, localTok: localToken\(card\) \}\);/);
  assert.match(content, /if \(!ch\.id && !targetHasId\(ch\)\) \{/);
});

test('a bare @handle is never used as a channel name', () => {
  const content = fs.readFileSync('content/content.js', 'utf8');
  const main = fs.readFileSync('content/main-world.js', 'utf8');
  // YouTube renders the byline as "@handle" for some cards: that is not the channel's name.
  assert.match(content, /const isHandle = \(t\) => \/\^@\\S\+\$\/\.test\(String\(t \|\| ''\)\.trim\(\)\);/);
  assert.match(content, /const isName = \(t\) =>/);
  assert.match(content, /if \(!isName\(name\)\) name = '';/);
  assert.match(main, /const cleanTitle = \(t\) =>/);
  assert.match(main, /return !s \|\| isHandle\(s\) \|\| isUC\(s\) \? '' : s;/);
  // A byline is split so only the title line can be the name.
  assert.match(content, /const parts = String\(hit\?\.textContent \|\| ''\)\.split/);
});

test('the card name comes from the lockup title, not its first metadata part', () => {
  const main = fs.readFileSync('content/main-world.js', 'utf8');
  // metadataParts[0] is often the @handle (e.g. "@almostperfectrestoration"), so the lockup's own
  // title is used first and handle parts are never taken as a name.
  assert.match(main, /const own = cleanTitle\(meta\?\.title\?\.content\);/);
  assert.match(main, /for \(const part of row\.metadataParts \|\| \[\]\) parts\.push\(cleanTitle\(part\?\.text\?\.content\)\);/);
  assert.doesNotMatch(main, /metadataParts\?\\.\[0\]\?\\.text\?\\.content/);
  assert.match(main, /ch\.name = cleanTitle\(lockupName\(/);
});

test('entries saved with a handle as their name repair themselves', () => {
  const content = fs.readFileSync('content/content.js', 'utf8');
  // The handle is kept, the wrong title is dropped, and one background refresh brings the real name.
  assert.match(content, /if \(!c\.handle && isHandle\(c\.title\)\) c\.handle = c\.title\.slice\(1\);/);
  assert.match(content, /c\.title = '';/);
  assert.match(content, /if \(fixed\) subsNeedsSync = true;/);
  assert.match(content, /if \(subsNeedsSync && subs\.ts\) setTimeout\(safe\(doSync\), 3000\);/);
  // And a later page of the list may improve a title instead of keeping the old one.
  const main = fs.readFileSync('content/main-world.js', 'utf8');
  assert.match(main, /const title = e\.title \|\| prev\?\.title \|\| '';/);
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
  // The copy looks like the corner and floating button it replaces on watch and channel pages:
  // same size, border and shadow, so a − means the same thing wherever it is clicked.
  const block = (selector) => {
    const at = css.indexOf(selector + ' {');
    return css.slice(at, css.indexOf('\n}', at));
  };
  const decl = (text, property) => text.match(new RegExp('(?:^|\\n)\\s*' + property + ':\\s*([^;]+);'))?.[1];
  const corner = block('.yousub-subbtn');
  const inlineCopy = block('.yousub-inlinebtn');
  for (const property of ['width', 'height', 'border', 'border-radius', 'box-shadow']) {
    assert.equal(decl(inlineCopy, property), decl(corner, property), `the copy uses the corner button's ${property}`);
  }
  assert.equal(decl(corner, 'width'), '34px');
  // Same strokes (15 × 3 px) and the same blue for the unsubscribe state.
  assert.match(css, /\.yousub-inlinebtn::after \{ width: 3px; height: 15px; \}/);
  const strokesAt = css.indexOf('.yousub-inlinebtn::before');
  const strokes = css.slice(strokesAt, css.indexOf('\n}', strokesAt));
  assert.match(strokes, /width: 15px;/);
  assert.match(strokes, /height: 3px;/);
  assert.match(css, /\.yousub-inlinebtn\.yousub-unsubbtn \{ background: var\(--yousub-unsub-btn, #1e88e5\) !important; \}/);
});

test('there are no keyboard shortcuts or hotkeys', () => {
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  assert.equal('commands' in manifest, false);
  for (const file of ['content/content.js', 'content/main-world.js', 'popup/popup.js']) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /addEventListener\('key(down|up|press)'|accessKey|KeyboardEvent|event\.key\b/, `${file} must not bind a keyboard shortcut`);
  }
});
