/* Human-readable name for a paired device, e.g. "iPhone · Safari" or
   "iPhone · Home Screen app", so entries in the Windows device list can be told apart. */
(function (root) {
  function deviceLabel({ userAgent = '', maxTouchPoints = 0, standalone = false } = {}) {
    const ua = String(userAgent);
    // iPadOS Safari reports a Mac user agent; touch support tells them apart.
    const touchMac = /Macintosh/.test(ua) && maxTouchPoints > 1;
    const device = /iPad/.test(ua) || touchMac ? 'iPad'
      : /iPhone|iPod/.test(ua) ? 'iPhone'
      : /Android/.test(ua) ? (/Mobile/.test(ua) ? 'Android phone' : 'Android tablet')
      : /CrOS/.test(ua) ? 'Chromebook'
      : /Windows/.test(ua) ? 'Windows PC'
      : /Macintosh/.test(ua) ? 'Mac'
      : /Linux/.test(ua) ? 'Linux PC'
      : 'Device';
    // Order matters: Edge, Opera and Samsung Internet also report "Chrome".
    const app = standalone ? 'Home Screen app'
      : /EdgiOS|EdgA\/|Edg\//.test(ua) ? 'Edge'
      : /OPiOS|OPR\//.test(ua) ? 'Opera'
      : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
      : /CriOS|Chrome\//.test(ua) ? 'Chrome'
      : /FxiOS|Firefox\//.test(ua) ? 'Firefox'
      : /Safari\//.test(ua) ? 'Safari'
      : 'Browser';
    return `${device} · ${app}`;
  }
  function currentDeviceLabel() {
    const standalone = root.navigator.standalone === true
      || !!(root.matchMedia && root.matchMedia('(display-mode: standalone)').matches);
    return deviceLabel({ userAgent: root.navigator.userAgent, maxTouchPoints: root.navigator.maxTouchPoints || 0, standalone });
  }
  if (typeof module !== 'undefined') { module.exports = { deviceLabel }; return; }
  root.QuickClipDevice = { deviceLabel, currentDeviceLabel };
})(typeof window === 'undefined' ? globalThis : window);
