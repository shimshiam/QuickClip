'use strict';
const path = require('path');
// These files can execute code, launch another program, or leak credentials when opened on Windows.
const DANGEROUS = new Set([
  // Executables, installers and packages
  'exe com scr pif cpl msi msp mst msu msc msix msixbundle appx appxbundle appinstaller application appref-ms xbap vsto gadget jar jnlp',
  // Scripts and script components
  'bat cmd ps1 psm1 psd1 ps1xml ps2 ps2xml psc1 psc2 cdxml msh msh1 msh2 mshxml msh1xml msh2xml py pyw sh bash rb pl vb vbs vbe js jse wsf wsh ws wsc sct hta',
  // Shortcuts, shell and system integration
  'lnk url website scf inf reg desktop library-ms searchconnector-ms settingcontent-ms search-ms theme themepack deskthemepack rdp diagcab diagcfg diagpkg ins isp its mcf shb shs xnk cnt hlp chm',
  // Disk images (contents bypass Mark-of-the-Web on older Windows)
  'iso img vhd vhdx',
  // Office add-ins, macro-capable documents and Access databases
  'docm dotm xlsm xltm xlam xla xll xlsb pptm potm ppam ppsm sldm mda mdb mde mdz accda accdb accde accdr accdt ade adp',
].join(' ').split(' '));

// Types QuickClip opens directly. Anything else is revealed in Explorer instead,
// where Windows applies Mark-of-the-Web prompts (SmartScreen, Protected View).
const OPEN_DIRECTLY = new Set(('png jpg jpeg gif webp avif bmp heic heif tif tiff pdf txt md csv log '
  + 'mp3 wav m4a aac flac ogg opus mp4 m4v mov webm mkv avi wmv docx xlsx pptx').split(' '));

function extensionOf(name) {
  return path.extname(String(name).replace(/[. ]+$/, '')).slice(1).toLowerCase();
}
function assertSafeFile(name) {
  if (typeof name !== 'string' || !name || name.length > 200 || /[:\x00-\x1f\u202a-\u202e\u2066-\u2069]/.test(name)) {
    throw new Error('Filename is invalid or too long');
  }
  if (DANGEROUS.has(extensionOf(name))) throw new Error('This file type is blocked for safety');
}
function canOpenDirectly(name) {
  return OPEN_DIRECTLY.has(extensionOf(name));
}
module.exports = { assertSafeFile, canOpenDirectly };
