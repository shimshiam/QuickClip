'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Multer's disk storage does not close its output on a disconnected request.
// Keep writes streamed while explicitly releasing and removing partial files.
function createUploadStorage(directory) {
  return {
    _handleFile(req, file, callback) {
      const filename = crypto.randomUUID();
      const target = path.join(directory, filename);
      const output = fs.createWriteStream(target, { flags: 'wx' });
      let completed = false;
      function failed(error) {
        if (completed) return;
        completed = true;
        req.removeListener('aborted', aborted);
        file.stream.unpipe(output);
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
      file.stream.pipe(output);
      if (req.aborted) aborted();
    },
    _removeFile(_req, file, callback) { fs.unlink(file.path, callback); },
  };
}
module.exports = { createUploadStorage };
