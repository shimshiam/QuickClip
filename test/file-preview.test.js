const test = require('node:test');
const assert = require('node:assert/strict');
const { profile } = require('../src/pwa/file-preview');

test('preview policy excludes active content, missing files, and oversized data', () => {
  for (const name of ['page.html', 'vector.svg', 'script.js', 'app.exe', 'document.docx', 'constructor', '__proto__']) {
    assert.equal(profile({ name, size: 10 }), null);
  }
  assert.equal(profile({ name: 'photo.png', size: 10, available: false }), null);
  assert.equal(profile({ name: 'notes.txt', size: 1048577 }), null);
  assert.equal(profile({ name: 'movie.mp4', size: 20971521 }), null);
  assert.equal(profile({ name: 'notes.txt', size: -1 }), null);
  assert.equal(profile({ name: 'photo.PNG', size: 10 }).type, 'image/png');
  assert.equal(profile({ name: 'document.pdf', size: 10 }).type, 'application/pdf');
});
