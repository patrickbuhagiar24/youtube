const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness() {
  const messages = [];
  class XHR {
    open() {}
    send() {}
    addEventListener(name, cb) { this.listener = cb; }
    finish(status, response) { this.status = status; this.responseText = JSON.stringify(response); this.listener(); }
  }
  let result = {};
  const window = { fetch: async () => ({ ok: true, clone: () => ({ json: async () => result }) }), postMessage: (data) => messages.push(data), addEventListener() {} };
  const context = vm.createContext({ window, document: { readyState: 'loading', addEventListener() {} }, location: { origin: 'https://www.youtube.com' }, YOUSUB: { CARD_SEL: '' }, XMLHttpRequest: XHR, Request, URL, setTimeout, clearTimeout, setInterval });
  vm.runInContext(fs.readFileSync('content/main-world.js', 'utf8'), context);
  return { window, XHR, messages, setResult: (v) => { result = v; } };
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
  assert.equal(h.messages[0].payload.ids[0], id);
  assert.equal(h.messages[0].payload.subscribed, false);
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
  assert.equal(h.messages.length, 2);
  assert.equal(h.messages[1].type, 'nativeRefreshRequested');
});

test('native renderer changes request a server refresh only after a stable transition', () => {
  const messages = [], timers = new Map(), events = {}, intervals = [];
  let next = 0;
  const button = { localName: 'ytd-subscribe-button-renderer', data: { channelId: id, subscribed: true }, isConnected: true };
  const document = {
    readyState: 'loading', documentElement: {},
    addEventListener: (name, fn) => { events[name] = fn; },
    querySelectorAll: () => [button], getElementsByTagName: () => [button]
  };
  class XHR { open() {} send() {} }
  class MutationObserver { observe() {} }
  const window = { fetch: async () => {}, postMessage: (m) => messages.push(m), addEventListener() {} };
  const setTimeout = (cb) => { const key = ++next; timers.set(key, cb); return key; };
  const context = vm.createContext({ window, document, location: { origin: 'https://www.youtube.com' }, YOUSUB: { CARD_SEL: '' }, XMLHttpRequest: XHR, Request, URL, MutationObserver, setTimeout, clearTimeout: (key) => timers.delete(key), setInterval: (cb) => intervals.push(cb) });
  vm.runInContext(fs.readFileSync('content/main-world.js', 'utf8'), context);
  events.DOMContentLoaded();
  assert.equal(messages.length, 0); // Initial renderer is not an action.
  button.data = { channelId: id, subscribed: false };
  intervals[0]();
  for (const cb of [...timers.values()]) cb();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'nativeButtonChanged');
  assert.equal(messages[0].payload.id, id);

  timers.clear(); messages.length = 0;
  button.data = { channelId: id, subscribed: true };
  intervals[0]();
  button.data = { channelId: id, subscribed: false }; // Optimistic transition reverted.
  for (const cb of [...timers.values()]) cb();
  assert.equal(messages.length, 0);
});

test('unknown request body triggers server refresh instead of guessing', async () => {
  const h = harness();
  await h.window.fetch(url, { body: '{"differentShape":true}' });
  await tick();
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].type, 'nativeRefreshRequested');
});

test('trusted native clicks and subsequent dialog confirmation request a refresh', () => {
  const listeners = {}, messages = [];
  class XHR { open() {} send() {} }
  const window = { fetch: async () => {}, postMessage: (m) => messages.push(m), addEventListener() {} };
  const document = { readyState: 'loading', addEventListener: (name, cb) => { listeners[name] = cb; } };
  const context = vm.createContext({ window, document, location: { origin: 'https://www.youtube.com' }, YOUSUB: { CARD_SEL: '' }, XMLHttpRequest: XHR, Request, URL, setTimeout, clearTimeout, setInterval });
  vm.runInContext(fs.readFileSync('content/main-world.js', 'utf8'), context);
  const node = (kind) => ({ matches: (selector) => selector.includes(kind), closest: () => null });
  const click = (kind, isTrusted = true) => listeners.click({ isTrusted, composedPath: () => [node(kind)] });
  click('ytd-confirm-dialog-renderer'); // No preceding subscription click.
  click('ytd-subscribe-button-renderer', false);
  assert.equal(messages.length, 0);
  click('ytd-subscribe-button-renderer');
  click('ytd-confirm-dialog-renderer');
  assert.deepEqual(messages.map((m) => m.type), ['nativeRefreshRequested', 'nativeRefreshRequested']);
});
