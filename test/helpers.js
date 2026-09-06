'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function load(relative, mocks = {}, globals = {}) {
  const filename = path.resolve(__dirname, '..', relative);
  const module = { exports: {} };
  const realRequire = createRequire(filename);
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename), __filename: filename,
    Buffer, URL, setInterval, clearInterval, setTimeout, clearTimeout,
    console, ...globals, require: (name) => name in mocks ? mocks[name] : realRequire(name),
  }, { filename });
  return module.exports;
}
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quickclip-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function fakeElectron() {
  const state = { text: '', image: Buffer.alloc(0), fail: false };
  const image = (buffer) => ({
    isEmpty: () => !buffer.length,
    toPNG: () => Buffer.from(buffer),
    toBitmap: () => Buffer.from(buffer),
    toDataURL: () => 'data:image/png;base64,dGh1bWI=',
    getSize: () => ({ width: 400, height: 300 }),
    resize: () => image(Buffer.from('thumb')),
  });
  return { state, shell: {}, nativeImage: {
    createFromBuffer: (buffer) => image(buffer[0] === 137 ? buffer : Buffer.alloc(0)),
  }, clipboard: {
    readText: () => state.text,
    readImage: () => image(state.image),
    writeText: (text) => { if (state.fail) throw new Error('Clipboard busy'); state.text = text; state.image = Buffer.alloc(0); },
    writeImage: (img) => { if (state.fail) throw new Error('Clipboard busy'); state.image = img.toPNG(); state.text = ''; },
  } };
}
// Header fixture for mocked decoding. Real native decoding is tested by the
// Electron smoke test using nativeImage-generated PNG bytes.
const pngHeader = Buffer.alloc(24);
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(pngHeader);
pngHeader.write('IHDR', 12); pngHeader.writeUInt32BE(400, 16); pngHeader.writeUInt32BE(300, 20);
module.exports = { load, temporary, fakeElectron, pngHeader };
