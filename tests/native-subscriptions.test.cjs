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
  assert.equal(h.messages.length, 1);
});
