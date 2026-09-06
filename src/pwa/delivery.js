(function (root) {
  'use strict';
  function createDelivery({ send, onState, timeout = 15000 }) {
    let pending, timer, expiry;
    const report = (state, error) => onState({ state, error });
    function transmit() {
      if (!pending) return;
      if (Date.now() - pending.createdAt >= 5 * 60 * 1000) {
        pending = null; clearTimeout(expiry); report('failed', 'Retry expired; send the clipboard again'); return;
      }
      clearTimeout(timer);
      report('sending');
      timer = setTimeout(() => report('unconfirmed', 'Delivery not confirmed. Reconnect and retry.'), timeout);
      try { send(pending.message, pending.buffer); }
      catch (err) { clearTimeout(timer); report('unconfirmed', err.message); }
    }
    return {
      start(message, buffer) {
        clearTimeout(timer); clearTimeout(expiry);
        pending = { message, buffer, createdAt: Date.now() };
        expiry = setTimeout(() => {
          pending = null; clearTimeout(timer); report('failed', 'Retry expired; send the clipboard again');
        }, 5 * 60 * 1000);
        transmit();
      },
      retry: transmit,
      receive(msg) {
        if (!pending || msg.id !== pending.message.id) return;
        clearTimeout(timer);
        pending = null; clearTimeout(expiry);
        report(msg.ok ? 'sent' : 'failed', msg.error || 'Windows rejected this transfer');
      },
      disconnect() { if (pending) { clearTimeout(timer); report('unconfirmed', 'Connection lost. Delivery not confirmed.'); } },
      dispose() { clearTimeout(timer); clearTimeout(expiry); pending = null; },
    };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { createDelivery };
  else root.QuickClipDelivery = { createDelivery };
})(typeof window !== 'undefined' ? window : globalThis);
