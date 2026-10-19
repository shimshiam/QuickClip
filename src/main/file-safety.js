'use strict';
const path = require('path');
// These files can execute code or launch another program when opened on Windows.
const DANGEROUS = new Set('exe com bat cmd py pyw sh bash rb pl msc msix msixbundle appx appxbundle desktop ps1 psm1 psd1 vbs vbe js jse wsf wsh msi msp mst scr pif lnk url hta cpl reg jar application appref-ms chm scf inf iso img vhd vhdx docm dotm xlsm xlam xltm pptm ppam'.split(' '));
function assertSafeFile(name) {
  if (typeof name !== 'string' || !name || name.length > 200 || /[:\x00-\x1f\u202a-\u202e\u2066-\u2069]/.test(name)) {
    throw new Error('Filename is invalid or too long');
  }
  const extension = path.extname(name.replace(/[. ]+$/, '')).slice(1).toLowerCase();
  if (DANGEROUS.has(extension)) throw new Error('This file type is blocked for safety');
}
module.exports = { assertSafeFile };
