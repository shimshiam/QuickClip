'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Writable } = require('stream');

// Multer's disk storage does not close its output on a disconnected request.
// Keep writes streamed while explicitly releasing and removing partial files.
function createUploadStorage(directory, reserveCapacity = () => () => {}) {
  return {
    _handleFile(req, file, callback) {
      const filename = crypto.randomUUID();
      const target = path.join(directory, filename);
      const output = fs.createWriteStream(target, { flags: 'wx' });
      const capacity = new Writable({ write(chunk, _encoding, done) {
        let release;
        try { release = reserveCapacity(chunk.length); } catch (err) { done(err); return; }
        output.write(chunk, (err) => { release(); done(err); });
      }, final(done) { output.end(); done(); } });
      let completed = false;
      function failed(error) {
        if (completed) return;
        completed = true;
        req.removeListener('aborted', aborted);
        file.stream.unpipe(capacity);
        capacity.destroy();
        file.stream.destroy();
        output.once('close', () => fs.unlink(target, () => callback(error)));
        output.destroy();
      }
      function aborted() { failed(new Error('Upload interrupted')); }
      req.once('aborted', aborted);
      output.on('error', failed);
      output.on('finish', () => {
        if (completed) return;
        completed = true;
        req.removeListener('aborted', aborted);
        // Windows must close the descriptor before the file can be renamed.
        output.once('close', () => callback(null, { path: target, filename, size: output.bytesWritten }));
      });
      capacity.on('error', failed);
      file.stream.on('error', failed);
      file.stream.pipe(capacity);
      if (req.aborted) aborted();
    },
    _removeFile(_req, file, callback) { fs.unlink(file.path, callback); },
  };
}
module.exports = { createUploadStorage };
