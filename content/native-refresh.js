/* Coalesce fallback refreshes without discarding other in-flight native actions. */
// eslint-disable-next-line no-unused-vars, no-var
var YousubNativeRefresh = (() => {
  function create({ refresh, ready, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    const pending = new Set();
    const confirmed = new Map();
    let timer = null;

    function schedule(delay) {
      if (timer !== null) clearTimer(timer);
      timer = setTimer(() => {
        timer = null;
        if (!pending.size) return;
        if (!ready()) { schedule(1000); return; }
        pending.clear();
        refresh();
      }, delay);
    }

    function request(seq) {
      pending.add(Number.isSafeInteger(seq) && seq >= 0 ? seq : 0);
      schedule(2000);
    }

    function confirm(seq, ids, subscribed) {
      if (!Number.isSafeInteger(seq) || seq < 0) return;
      for (const id of ids) {
        confirmed.delete(id);
        confirmed.set(id, { seq, subscribed, at: now() });
      }
      while (confirmed.size > 200) confirmed.delete(confirmed.keys().next().value);
      pending.delete(seq);
      if (!pending.size && timer !== null) { clearTimer(timer); timer = null; }
    }

    function buttonChanged(seq, id, subscribed) {
      const last = confirmed.get(id);
      // The same response has already updated this channel. A later action,
      // different state or unknown sequence must still be checked.
      if (seq > 0 && last && last.seq === seq && last.subscribed === subscribed && now() - last.at < 10000) return;
      request(seq);
    }

    return { request, confirm, buttonChanged };
  }
  return { create };
})();
