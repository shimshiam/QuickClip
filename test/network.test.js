'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { load } = require('./helpers');

const address = (value, extra = {}) => ({ address: value, family: 'IPv4', internal: false, ...extra });
function network(interfaces) {
  return load('src/main/network.js', { os: { networkInterfaces: () => interfaces } });
}

test('LAN wins over virtual adapters, VPNs, CGNAT and link-local regardless of enumeration order', () => {
  for (const name of ['vEthernet (WSL)', 'Docker', 'VMware Network Adapter VMnet8', 'VirtualBox Host-Only', 'Tailscale', 'ZeroTier One', 'WireGuard Tunnel', 'OpenVPN TAP']) {
    for (const lan of ['192.168.1.42', '10.0.0.42', '172.20.0.42']) {
      const interfaces = { [name]: [address('192.168.163.1')], 'Wi-Fi': [address(lan)] };
      assert.equal(network(interfaces).getLocalIP(), lan, name);
      assert.equal(network(Object.fromEntries(Object.entries(interfaces).reverse())).getLocalIP(), lan, name);
    }
  }
  assert.equal(network({ Ethernet: [address('169.254.2.1')], mesh: [address('100.64.1.1')], LAN: [address('172.16.0.5')] }).getLocalIP(), '172.16.0.5');
  assert.equal(network({ Docker: [address('10.0.0.1')], Ethernet: [address('203.0.113.2')] }).getLocalIP(), '203.0.113.2');
});

test('filters unusable addresses, handles numeric families, and keeps a deterministic fallback', () => {
  const interfaces = { empty: undefined, loopback: [address('127.0.0.1'), address('10.1.1.1', { internal: true })],
    invalid: [address('bad'), address('0.0.0.0'), address('224.1.1.1'), address('::1', { family: 'IPv6' })],
    'Wi-Fi': [address('192.168.0.2', { family: 4 }), address('192.168.0.2')], Ethernet: [address('192.168.0.3')] };
  const api = network(interfaces);
  assert.equal(api.getNetworkInterfaces().length, 2);
  assert.equal(api.getLocalIP(), network(Object.fromEntries(Object.entries(interfaces).reverse())).getLocalIP());
  assert.equal(network({}).getLocalIP(), '127.0.0.1');
  assert.equal(network({ VPN: [address('10.8.0.2')] }).getLocalIP(), '10.8.0.2');
  assert.equal(network({ Ethernet: [address('169.254.1.2')] }).getLocalIP(), '169.254.1.2');
  const failed = load('src/main/network.js', { os: { networkInterfaces() { throw new Error('enumeration failed'); } } });
  assert.equal(failed.getLocalIP(), '127.0.0.1');
});

test('manual override can select a VPN, follow DHCP, and fall back when unavailable', () => {
  const api = network({ Ethernet: [address('192.168.1.3')], VPN: [address('10.8.0.3'), address('10.8.0.4')] });
  assert.equal(api.getLocalIP({ name: 'VPN', address: '10.8.0.4' }), '10.8.0.4');
  assert.equal(api.getLocalIP({ name: 'VPN', address: '10.8.0.2' }), '10.8.0.3');
  assert.equal(api.getLocalIP({ name: 'Missing', address: '10.8.0.2' }), '192.168.1.3');
  assert.equal(api.getLocalIP(null), '192.168.1.3');
});

test('tray exposes automatic and manual choices and refreshes unavailable adapters', () => {
  let tray, template, selection;
  let state = { candidates: [{ name: 'Wi-Fi', address: '192.168.1.3' }, { name: 'VPN & Mesh', address: '10.8.0.4' }], preferred: null, activeIP: '192.168.1.3' };
  class Tray extends EventEmitter {
    constructor() { super(); tray = this; }
    setToolTip() {} setContextMenu(menu) { template = menu; }
  }
  const api = load('src/main/tray.js', { electron: { Tray, Menu: { buildFromTemplate: (menu) => menu },
    nativeImage: { createFromPath: () => ({ isEmpty: () => false }) } } });
  api.createTray(null, '', { getState: () => state, select: (value) => { selection = value; } });
  const choices = () => template.find((item) => item.label === 'Network Interface').submenu;
  assert.equal(choices().find((item) => item.label === 'Automatic').checked, true);
  choices().find((item) => item.label?.startsWith('VPN')).click();
  assert.equal(selection.name, 'VPN & Mesh');
  state = { ...state, preferred: selection, candidates: [state.candidates[0]] };
  tray.emit('right-click');
  assert.equal(choices().find((item) => item.label?.includes('unavailable')).checked, true);
  choices().find((item) => item.label === 'Automatic').click();
  assert.equal(selection, null);
});
