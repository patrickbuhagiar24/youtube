const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

/**
 * The extension only observes the subscription requests YouTube itself sends.
 * It never adds work to, or triggers anything from, the native Subscribe button.
 */
function harness() {
  const messages = [];
  const listeners = {};
  class XHR {
    open(method, url) { this.url = url; }
    send() {}
    addEventListener(name, cb) { this.listener = cb; }
    finish(status, response) { this.status = status; this.responseText = JSON.stringify(response); this.listener(); }
  }
  let result = {};
  const window = { fetch: async () => ({ ok: true, clone: () => ({ json: async () => result }) }), postMessage: (data) => messages.push(data), addEventListener() {} };
  const document = { readyState: 'loading', addEventListener: (name, fn) => { listeners[name] = fn; } };
  const context = vm.createContext({ window, document, location: { origin: 'https://www.youtube.com' }, YOUSUB: { CARD_SEL: '' }, XMLHttpRequest: XHR, Request, URL, setTimeout, clearTimeout, setInterval });
  // The filename lets the test runner attribute V8 coverage to the real file.
  vm.runInContext(fs.readFileSync('content/main-world.js', 'utf8'), context, { filename: path.resolve('content/main-world.js') });
  return { window, XHR, messages, listeners, setResult: (v) => { result = v; } };
}
const id = 'UCabcdefghijklmnopqrstuv';
const url = 'https://www.youtube.com/youtubei/v1/subscription/unsubscribe';
const body = JSON.stringify({ channelIds: [id] });
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('native fetch action is applied only after a successful response', async () => {
  const h = harness();
  h.setResult({ actions: [{ updateSubscribeButtonAction: { subscribed: false } }] });
  await h.window.fetch(url, { body }); await tick();
  assert.equal(h.messages.length, 1);
  const [message] = h.messages;
  assert.equal(message.source, 'yousub-main');
  assert.equal(message.type, 'subChange');
  assert.deepEqual([...message.payload.ids], [id]);
  assert.equal(message.payload.subscribed, false);
  assert.equal('seq' in message.payload, false); // Nothing to confirm or retry later
  h.setResult({ error: { message: 'failed' } });
  await h.window.fetch(url, { body }); await tick();
  h.setResult({ actions: [{ updateSubscribeButtonAction: { subscribed: true } }] });
  await h.window.fetch(url, { body }); await tick();
  assert.equal(h.messages.length, 1);
});

test('native XHR requires success and a valid channel ID', () => {
  const h = harness();
  const xhr = new h.XHR(); xhr.open('POST', url); xhr.send(body); xhr.finish(200, {});
  assert.equal(h.messages.length, 1);
  const bad = new h.XHR(); bad.open('POST', url); bad.send(body); bad.finish(403, {});
  const invalid = new h.XHR(); invalid.open('POST', url); invalid.send('{"channelIds":["invalid"]}'); invalid.finish(200, {});
  assert.equal(h.messages.length, 1); // Failures and unknown IDs apply nothing.
});

test('unknown request body or unreadable response triggers no follow-up work', async () => {
  const h = harness();
  await h.window.fetch(url, { body: '{"differentShape":true}' });
  await tick();
  await h.window.fetch(url, {});
  await tick();
  assert.deepEqual(h.messages, []);
});

test('the native Subscribe button gets no click, dialog, or polling hooks', () => {
  const source = fs.readFileSync('content/main-world.js', 'utf8');
  // No listener on YouTube's own button, its confirmation dialog, or the old refresh fallbacks.
  assert.doesNotMatch(source, /CONFIRM_BUTTON|confirm-dialog-renderer/);
  assert.doesNotMatch(source, /nativeButtonChanged|nativeRefreshRequested|scanButtons|getElementsByTagName/);
  assert.doesNotMatch(source, /addEventListener\('click'/);
  assert.doesNotMatch(source, /CONFIRM_BUTTON|nativeButtonChanged|nativeRefreshRequested|scanButtons/);
  // Its element may only be read (see localSubscribeIdentity): never hooked or clicked here.
  assert.doesNotMatch(source, /(subscribe-button-renderer|yt-subscribe-button-view-model)[^\n]*addEventListener/);
  assert.doesNotMatch(source, /\.click\(\)/);
  // YouTube's button is not polled: the safety-net interval only rescans cards.
  assert.match(source, /setInterval\(\(\) => \{ if \(!document\.hidden\) scan\(\); \}, 10000\)/);
});

test('the content script keeps no fallback refresh tied to the native button', () => {
  const content = fs.readFileSync('content/content.js', 'utf8');
  assert.doesNotMatch(content, /YousubNativeRefresh|nativeButtonChanged|nativeRefreshRequested/);
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  const scripts = manifest.content_scripts.flatMap((entry) => entry.js);
  assert.ok(!scripts.includes('content/native-refresh.js'));
  assert.ok(!fs.existsSync('content/native-refresh.js'));
});

test('the identity lookup reads a tagged button element, not only its children', () => {
  const source = fs.readFileSync('content/main-world.js', 'utf8');
  // Regression: the content script tags the button element itself, and querySelectorAll never
  // returns the element it is called on, so the lookup used to answer nothing at all.
  assert.match(source, /if \(scope\.matches\?\.\(NATIVE_BTN_SEL\)\) found\.unshift\(scope\);/);
  assert.match(source, /const NATIVE_BTN_SEL = 'ytd-subscribe-button-renderer, yt-subscribe-button-renderer, yt-subscribe-button-view-model';/);
  // It must fall back to channel data the page already has, so no click is left without an ID.
  assert.match(source, /function pageChannelId\(\)/);
  assert.match(source, /ytInitialPlayerResponse\?\.videoDetails\?\.channelId/);
  // And a request without an ID is resolved from the page (video on /watch, URL on a channel page).
  assert.match(source, /function pageHint\(hint = \{\}\)/);
  assert.match(source, /ids = \[await resolveChannelId\(pageHint\(hint\)\)\]/);
});

test('an unknown login state is never reported as signed out', () => {
  const source = fs.readFileSync('content/main-world.js', 'utf8');
  // ytcfg may not exist yet when the page asks; !!undefined would have said "signed out"
  // and the isolated script would then hide every marker.
  assert.match(source, /loggedIn: typeof cfg\('LOGGED_IN'\) === 'boolean' \? cfg\('LOGGED_IN'\) : null/);
  assert.doesNotMatch(source, /loggedIn: !!cfg\('LOGGED_IN'\)/);
  assert.match(source, /const configured = await waitCfg\(\);/);
  assert.match(source, /configured \? \{\} : \{ loggedIn: null \}/);
});

test('hidden tabs are scanned so markers are ready when the tab is shown', () => {
  const content = fs.readFileSync('content/content.js', 'utf8');
  assert.match(content, /setInterval\(\(\) => extAlive && \(\+\+tick % 4 === 0 \|\| document\.documentElement\.classList\.contains\('yousub-autoload'\)\) && scheduleScan\(\), 2500\)/);
  assert.doesNotMatch(content, /extAlive && !document\.hidden/);
  // Autoload itself stays visible-only: it must not load pages in the background.
  assert.match(content, /!auto\.done && !document\.hidden && AUTOLOAD_PATH/);
});
