const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function harness() {
  let now = 0, next = 0, refreshes = 0, ready = true;
  const timers = new Map();
  const context = vm.createContext({ Date, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync('content/native-refresh.js', 'utf8'), context);
  const controller = context.YousubNativeRefresh.create({
    refresh: () => { refreshes++; }, ready: () => ready, now: () => now,
    setTimer: (fn, delay) => { const id = ++next; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimer: (id) => timers.delete(id)
  });
  function advance(ms) {
    const end = now + ms;
    while (true) {
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); now = due[1].at; due[1].fn();
    }
    now = end;
  }
  return { controller, advance, get refreshes() { return refreshes; }, setReady: (value) => { ready = value; } };
}
const id = 'UCabcdefghijklmnopqrstuv';

test('confirmed direct update cancels only its fallback and matching button transition', () => {
  const h = harness();
  h.controller.request(1);
  h.controller.confirm(1, [id], true);
  h.controller.buttonChanged(1, id, true);
  h.advance(5000);
  assert.equal(h.refreshes, 0);
});

test('unknown action, different state and expired observation retain fallback', () => {
  const h = harness();
  h.controller.request(1); h.advance(2000);
  assert.equal(h.refreshes, 1);
  h.controller.confirm(2, [id], true);
  h.controller.buttonChanged(2, id, false); h.advance(2000);
  assert.equal(h.refreshes, 2);
  h.advance(10000); h.controller.buttonChanged(2, id, true); h.advance(2000);
  assert.equal(h.refreshes, 3);
});

test('older success does not cancel a later unresolved action', () => {
  const h = harness();
  h.controller.request(1); h.controller.request(2);
  h.controller.confirm(1, [id], true);
  h.advance(2000);
  assert.equal(h.refreshes, 1);
});

test('multiple actions coalesce and wait for an existing refresh to finish', () => {
  const h = harness();
  h.setReady(false); h.controller.request(1); h.controller.request(2); h.advance(4000);
  assert.equal(h.refreshes, 0);
  h.controller.confirm(1, [id], true);
  h.setReady(true); h.advance(1000);
  assert.equal(h.refreshes, 1);
});
