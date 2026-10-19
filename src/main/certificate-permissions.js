'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function protectCertificateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const root = fs.lstatSync(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Certificate storage must be a regular directory');
  const files = fs.readdirSync(directory).map((name) => path.join(directory, name));
  for (const file of files) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error('Certificate storage contains an unexpected link or directory');
    }
  }
  if (process.platform === 'win32') {
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    try {
      execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(__dirname, 'protect-certificates.ps1'), '-CertificateDirectory', path.resolve(directory)],
      { windowsHide: true, timeout: 30000, stdio: 'pipe' });
    } catch (_) {
      throw new Error('Could not restrict certificate storage to your Windows account and SYSTEM. QuickClip will not start. Check ownership and NTFS permissions of the runtime/certs folder.');
    }
  } else {
    fs.chmodSync(directory, 0o700);
    for (const file of files) fs.chmodSync(file, 0o600);
  }
}
module.exports = { protectCertificateDirectory };
