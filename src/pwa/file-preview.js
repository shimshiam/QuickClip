/* Shared preview policy. Text is rendered literally, never as HTML. */
(function (root) {
 const types = {png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',avif:'image/avif',bmp:'image/bmp',pdf:'application/pdf',txt:'text/plain',md:'text/plain',csv:'text/plain',json:'text/plain',log:'text/plain',mp3:'audio/mpeg',wav:'audio/wav',m4a:'audio/mp4',ogg:'audio/ogg',mp4:'video/mp4',webm:'video/webm',mov:'video/quicktime'};
 function profile(file) {
  const extension = String(file.name).split('.').pop().toLowerCase();
  const type = Object.hasOwn(types, extension) ? types[extension] : null;
  const limit = type === 'text/plain' ? 1048576 : 20971520;
  return type && file.available !== false && Number(file.size) >= 0 && Number(file.size) <= limit ? {type,limit} : null;
 }
 if (typeof module !== 'undefined') { module.exports = {profile}; return; }
 function show(file, load) {
  const dialog = document.createElement('dialog'); dialog.className = 'file-preview-dialog';
  dialog.setAttribute('aria-label', 'Preview ' + file.name);
  dialog.innerHTML = '<header><h2></h2><button type="button">Close</button></header><div class="file-preview-content" aria-live="polite">Loading preview…</div>';
  dialog.querySelector('h2').textContent = file.name;
  const panel = dialog.querySelector('div'), controller = new AbortController(); let url;
  dialog.querySelector('button').onclick = () => dialog.close();
  dialog.onclick = e => { if(e.target === dialog) dialog.close(); };
  dialog.onclose = () => { controller.abort(); dialog.remove(); if(url) URL.revokeObjectURL(url); };
  document.body.append(dialog); dialog.showModal();
  load(controller.signal).then(async blob => {
   if(controller.signal.aborted) return;
   const info = profile(file); if(!info || blob.size > info.limit) throw new Error('Too large');
   if(info.type === 'text/plain') {
    const text = await blob.text(); if(controller.signal.aborted) return;
    const pre = document.createElement('pre'); pre.textContent = text; panel.replaceChildren(pre); return;
   }
   url = URL.createObjectURL(new Blob([blob], {type:info.type}));
   const tag = info.type.startsWith('image/') ? 'img' : info.type.startsWith('audio/') ? 'audio' : info.type.startsWith('video/') ? 'video' : 'iframe';
   const media = document.createElement(tag);
   if(tag === 'iframe') { media.title = file.name; media.setAttribute('referrerpolicy','no-referrer'); }
   if(tag === 'img') media.alt = file.name;
   if(tag === 'audio' || tag === 'video') { media.controls = true; media.preload = 'metadata'; }
   media.onerror = () => { panel.textContent = 'This format could not be previewed. Use Open or Save to view it.'; };
   media.src = url; panel.replaceChildren(media);
  }).catch(() => { if(!controller.signal.aborted) panel.textContent = 'Preview unavailable. Use Open or Save to view the file.'; });
 }
 function attach(icon, file, load) {
  const info = profile(file); if(!info) return;
  const button = document.createElement('button'); button.type = 'button'; button.className = icon.className + ' file-preview-button'; button.innerHTML = icon.innerHTML;
  button.title = 'Preview ' + file.name; button.setAttribute('aria-label',button.title);
  if(!info.type.startsWith('image/')) button.textContent = info.type === 'application/pdf' ? 'PDF' : info.type === 'text/plain' ? 'TXT' : info.type.startsWith('audio/') ? '♪' : '▶';
  icon.replaceWith(button); button.onclick = e => { e.stopPropagation(); show(file,load); };
  if(!info.type.startsWith('image/')) return;
  const controller = new AbortController(); let url;
  const cleanup = new MutationObserver(() => { if(!button.isConnected) { observer.disconnect(); cleanup.disconnect(); controller.abort(); if(url) URL.revokeObjectURL(url); } });
  cleanup.observe(document.body,{childList:true,subtree:true});
  const observer = new IntersectionObserver(entries => {
   if(!entries.some(e => e.isIntersecting)) return; observer.disconnect();
   load(controller.signal).then(blob => {
    if(controller.signal.aborted || blob.size > info.limit) return;
    url = URL.createObjectURL(new Blob([blob],{type:info.type}));
    const img = document.createElement('img'); img.alt = ''; img.onload = () => button.replaceChildren(img); img.onerror = () => URL.revokeObjectURL(url); img.src = url;
   }).catch(() => {});
  }); observer.observe(button);
 }
 root.FilePreview = {profile,attach,closeAll: () => document.querySelectorAll('.file-preview-dialog').forEach(dialog => dialog.close())};
})(typeof window === 'undefined' ? globalThis : window);
