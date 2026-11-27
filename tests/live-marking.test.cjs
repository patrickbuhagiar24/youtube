const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM, VirtualConsole } = require('jsdom');

/**
 * After a subscribe or an unsubscribe, every card of that channel on the open page must show the
 * new outline at once: no reload, and no card left on the old frame. Cards are matched by channel
 * ID and, when YouTube renders only a byline, by channel name.
 */
const SUBBED = 'UCabcdefghijklmnopqrstuv';
const TARGET = 'UCyyyyyyyyyyyyyyyyyyyy';

/** Home page: four cards, two of them the same channel as the button that is clicked. */
const HOME = `<!doctype html><html><body>
  <ytd-page-manager><div id="page">
    <ytd-rich-item-renderer data-yousub-cid="${SUBBED}" data-yousub-name="Chan One"><ytd-thumbnail></ytd-thumbnail></ytd-rich-item-renderer>
    <ytd-rich-item-renderer data-yousub-cid="${TARGET}" data-yousub-name="Chan Two"><ytd-thumbnail></ytd-thumbnail></ytd-rich-item-renderer>
    <ytd-rich-item-renderer data-yousub-cid="${TARGET}" data-yousub-name="Chan Two"><ytd-thumbnail></ytd-thumbnail></ytd-rich-item-renderer>
    <ytd-rich-item-renderer data-yousub-name="Chan Two"><ytd-thumbnail></ytd-thumbnail><ytd-channel-name><div id="text">Chan Two</div></ytd-channel-name></ytd-rich-item-renderer>
  </div></ytd-page-manager>
  </body></html>`;

/** Watch page: YouTube's own button in the owner row, the same channel in the sidebar below. */
const WATCH = `<!doctype html><html><body>
  <ytd-page-manager><div id="page"><ytd-watch-flexy>
    <div id="owner"><ytd-video-owner-renderer>
      <ytd-channel-name><div id="text">Chan Two</div></ytd-channel-name>
      <yt-subscribe-button-view-model>Subscribe</yt-subscribe-button-view-model>
    </ytd-video-owner-renderer></div>
    <div id="related"><ytd-item-section-renderer><div id="contents">
      <ytd-compact-video-renderer data-yousub-cid="${TARGET}" data-yousub-name="Chan Two"><ytd-thumbnail></ytd-thumbnail></ytd-compact-video-renderer>
      <ytd-compact-video-renderer data-yousub-cid="${TARGET}" data-yousub-name="Chan Two"><ytd-thumbnail></ytd-thumbnail></ytd-compact-video-renderer>
      <ytd-compact-video-renderer data-yousub-name="Chan Two"><ytd-thumbnail></ytd-thumbnail><ytd-channel-name><div id="text">Chan Two</div></ytd-channel-name></ytd-compact-video-renderer>
    </div></ytd-item-section-renderer></div>
  </ytd-watch-flexy></div></ytd-page-manager></body></html>`;

/** Channel page: YouTube's own button in the header, the channel's videos in the grid below. */
const CHANNEL = `<!doctype html><html><body>
  <ytd-page-manager><div id="page">
    <yt-page-header-renderer><h1>Chan Two</h1></yt-page-header-renderer>
    <div id="header-row"><yt-subscribe-button-view-model>Subscribe</yt-subscribe-button-view-model></div>
    <ytd-rich-grid-renderer><div id="contents">
      <ytd-rich-item-renderer data-yousub-cid="${TARGET}" data-yousub-name="Chan Two"><ytd-thumbnail></ytd-thumbnail></ytd-rich-item-renderer>
      <ytd-rich-item-renderer data-yousub-cid="${TARGET}" data-yousub-name="Chan Two"><ytd-thumbnail></ytd-thumbnail></ytd-rich-item-renderer>
      <ytd-rich-item-renderer data-yousub-name="Chan Two"><ytd-thumbnail></ytd-thumbnail><ytd-channel-name><div id="text">Chan Two</div></ytd-channel-name></ytd-rich-item-renderer>
    </div></ytd-rich-grid-renderer>
  </ytd-page-manager></body></html>`;

function harness({ drive = false, url = 'https://www.youtube.com/', html = HOME, cardSel = 'ytd-rich-item-renderer' } = {}) {
  const virtualConsole = new VirtualConsole();
  const errors = [];
  virtualConsole.on('jsdomError', (e) => errors.push(e.message));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  let writes = 0;
  window.chrome = {
    runtime: {
      getManifest: () => ({ version: '0.0.0' }),
      sendMessage: (_m, cb) => { if (cb) cb({ ok: true }); },
      onMessage: { addListener() {} },
      id: 'test'
    },
    storage: {
      sync: { get: async () => ({ yousubSettings: {} }) },
      local: {
        get: async () => ({
          yousubSubs: {
            list: [{ id: SUBBED, title: 'Chan One', url: '/@chanone' }],
            ts: Date.now() - 1000, accountId: 'a1', stats: { status: 'ok' }
          },
          yousubUnsubs: {},
          // Without a configuration file the history is not kept, so an unsubscribed channel is
          // simply "not subscribed" and is never painted as "previously unsubscribed".
          yousubDriveConfig: drive ? { clientId: '1234-abc.apps.googleusercontent.com', link: 'https://drive.google.com/file/d/x/view' } : {}
        }),
        set: async () => { writes++; }
      },
      onChanged: { addListener() {} }
    }
  };
  // The isolated world talks to the MAIN world with window messages; answer them from here.
  const reply = (type, payload) => window.dispatchEvent(new window.MessageEvent('message', {
    data: { source: 'yousub-main', type, payload }, origin: 'https://www.youtube.com', source: window
  }));
  window.addEventListener('message', (e) => {
    const d = e.data || {};
    if (d.source !== 'yousub-content') return;
    if (d.type === 'hello') reply('hello', { reqId: d.reqId, loggedIn: true, accountId: 'a1' });
    else if (d.type === 'subscription') reply('subscription', { reqId: d.reqId, ids: d.ids?.length ? d.ids : [TARGET] });
    else if (d.type === 'identityLocal') reply('identityLocal', { reqId: d.reqId, id: TARGET, name: 'Chan Two', url: '/@chantwo' });
  });
  window.eval(fs.readFileSync('shared.js', 'utf8'));
  window.eval(fs.readFileSync('content/content.js', 'utf8'));
  const cards = () => [...window.document.querySelectorAll(cardSel)];
  const states = () => cards().map((c) => c.getAttribute('data-yousub-state'));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  return { window, cards, states, wait, errors, writes: () => writes };
}

test('a subscribe updates every card of that channel without a reload', async (t) => {
  const h = harness();
  t.after(() => h.window.close());
  await h.wait(700);
  assert.deepEqual(h.states(), ['sub', 'unsub', 'unsub', 'unsub']);
  const button = h.cards()[1].querySelector('.yousub-subbtn');
  assert.ok(button, 'the corner + button is placed on an unsubscribed card');
  button.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await h.wait(700);
  // Same document, no navigation: the other two cards of Chan Two follow the click.
  assert.deepEqual(h.states(), ['sub', 'sub', 'sub', 'sub']);
  assert.deepEqual(h.errors, []);
  assert.ok(h.writes() > 0, 'the subscription list is persisted');
});

test('an unsubscribe updates every card of that channel without a reload', async (t) => {
  const h = harness({ drive: true });
  t.after(() => h.window.close());
  await h.wait(700);
  const button = h.cards()[1].querySelector('.yousub-subbtn');
  button.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await h.wait(400);
  assert.deepEqual(h.states(), ['sub', 'sub', 'sub', 'sub']);
  // YouTube's own Unsubscribe succeeds: the MAIN world reports the confirmed channel.
  h.window.dispatchEvent(new h.window.MessageEvent('message', {
    data: { source: 'yousub-main', type: 'subChange', payload: { ids: [TARGET], subscribed: false } },
    origin: 'https://www.youtube.com', source: h.window
  }));
  await h.wait(400);
  // History is configured, so the two cards that carry the channel ID switch to the colour for
  // channels left earlier; the byline-only card has no ID to look the entry up.
  assert.deepEqual(h.states(), ['sub', 'left', 'left', 'unsub']);
  assert.deepEqual(h.errors, []);
});

test('without Drive sync an unchecked channel is never painted as history', async (t) => {
  const h = harness();
  t.after(() => h.window.close());
  await h.wait(700);
  const button = h.cards()[1].querySelector('.yousub-subbtn');
  button.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await h.wait(400);
  assert.deepEqual(h.states(), ['sub', 'sub', 'sub', 'sub']);
  h.window.dispatchEvent(new h.window.MessageEvent('message', {
    data: { source: 'yousub-main', type: 'subChange', payload: { ids: [TARGET], subscribed: false } },
    origin: 'https://www.youtube.com', source: h.window
  }));
  await h.wait(400);
  // No configuration: every card of the channel is plain "not subscribed", at once.
  assert.deepEqual(h.states(), ['sub', 'unsub', 'unsub', 'unsub']);
  assert.deepEqual(h.errors, []);
});

test("the copy beside YouTube's button on a watch page updates the page", async (t) => {
  const h = harness({ url: 'https://www.youtube.com/watch?v=abc12345678', html: WATCH, cardSel: 'ytd-compact-video-renderer, ytd-video-owner-renderer' });
  t.after(() => h.window.close());
  await h.wait(700);
  assert.deepEqual(h.states(), ['unsub', 'unsub', 'unsub', 'unsub']);
  const inline = h.window.document.querySelector('ytd-video-owner-renderer .yousub-inlinebtn');
  assert.ok(inline, 'a copy sits beside the owner row button');
  inline.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await h.wait(700);
  // The owner row and every sidebar video of that channel, including the byline-only one.
  assert.deepEqual(h.states(), ['sub', 'sub', 'sub', 'sub']);
  assert.equal(h.window.document.querySelector('ytd-video-owner-renderer .yousub-inlinebtn').textContent, '−');
  assert.deepEqual(h.errors, []);
});

test("the copy beside the header button on a channel page updates the page", async (t) => {
  const h = harness({ url: 'https://www.youtube.com/@chantwo/videos', html: CHANNEL });
  t.after(() => h.window.close());
  await h.wait(700);
  assert.deepEqual(h.states(), ['unsub', 'unsub', 'unsub']);
  const inline = h.window.document.querySelector('#header-row .yousub-inlinebtn');
  assert.ok(inline, 'a copy sits beside the header button');
  inline.dispatchEvent(new h.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await h.wait(700);
  assert.deepEqual(h.states(), ['sub', 'sub', 'sub']);
  assert.equal(h.window.document.querySelector('#header-row .yousub-inlinebtn').textContent, '−');
  assert.deepEqual(h.errors, []);
});
