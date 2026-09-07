# QuickClip — Technical Edge Cases & Resilience Guide

This document is a historical review. The implementation now uses confirmed clipboard transfers, bounded payloads, current-content hash tracking instead of a one-second echo guard, disk-backed clipboard images, disk-streamed uploads, and per-user runtime storage. See README.md for current behavior and verification. The observations below describe the earlier implementation and remaining platform considerations.

Each section details potential failure modes and actionable mitigation strategies based on the current codebase.

---

## 1. Network Discovery & Interface Management (`network.js`)

### 1.1. Virtual Network Adapter Trapping
* **Status: Fixed.** Automatic selection ranks likely LAN interfaces ahead of known virtual/VPN adapters and link-local addresses, with deterministic tie-breaking. The tray's **Network Interface** submenu provides a persisted manual override and an **Automatic** option. Changing the choice restarts QuickClip so certificates, accepted hosts, and pairing details agree. An unavailable preferred adapter falls back to automatic selection. See README.md for usage and limitations. The description below records the original failure.
* **Location:** [`src/main/network.js:L16-L31`](file:///d:/VSCode/QuickClip/src/main/network.js#L16-L31) (`getLocalIP`)
* **The Edge Case:**
  Currently, `getLocalIP()` iterates through `os.networkInterfaces()` and returns the **first** non-internal IPv4 address it encounters (`if (!iface.internal && iface.family === 'IPv4') return iface.address;`).
  If a Windows machine has virtualized adapters active—such as Hyper-V (`vEthernet`), WSL2 (`172.x`), Docker (`172.17.x`), VMware (`192.168.163.x`), or VPN/ZeroTier/Tailscale (`100.64.x`) interfaces—Node.js may enumerate the virtual interface before the physical LAN/Wi-Fi adapter (`192.168.x.x`).
* **Impact:**
  The generated QR code encodes an unreachable IP address (`https://172.17.0.1:8443`). When the iPhone scans the QR code over local Wi-Fi, connection timeouts occur immediately.
* **Mitigation:**
  * Score and prioritize network interfaces: rank standard private subnet ranges (`192.168.0.0/16` and `10.0.0.0/8` on standard Ethernet/Wi-Fi adapters) above known virtual adapter names (`*vEthernet*`, `*WSL*`, `*VMware*`, `*Docker*`).
  * Add an explicit **Network Interface Selector** in the system tray menu (`tray.js`) allowing users to override the detected interface.

---

### 1.2. IP Address Shifts During Sleep/Resume (DHCP Lease Renewal)
* **Location:** [`src/main/certificates.js:L78`](file:///d:/VSCode/QuickClip/src/main/certificates.js#L78) & [`src/main/main.js:L257`](file:///d:/VSCode/QuickClip/src/main/main.js#L257)
* **The Edge Case:**
  QuickClip checks `getLocalIP()` once on application startup. If the Windows PC enters sleep mode and wakes up connected to a different Wi-Fi access point or receives a new IP via DHCP (e.g., shifting from `192.168.1.42` to `192.168.1.55`), the Express (`server.js`), WebSocket (`wss`), and `mkcert` certificate (`server.crt`) remain bound to the outdated IP address.
* **Impact:**
  The iPhone PWA drops its connection and cannot reconnect using its cached IP or the stale QR code on screen.
* **Mitigation:**
  * Hook into Electron's `powerMonitor` module (`powerMonitor.on('resume')`) and OS network state events (`net.isOnline()`).
  * When a LAN IP change is detected live, trigger `generateCertificates()` for the new IP, restart the HTTPS/WS server on the new IP, re-broadcast via mDNS, and update the QR code inside `mainWindow`.

---

### 1.3. Router AP Isolation & Subnet Boundaries
* **Location:** `startMDNS(port)` in [`src/main/network.js`](file:///d:/VSCode/QuickClip/src/main/network.js)
* **The Edge Case:**
  Many corporate networks, public/school Wi-Fi networks, and home guest networks enable **AP Isolation (Client Isolation)**, which blocks direct peer-to-peer TCP (`port 8443`) and UDP broadcast (`port 5353`) communication between connected devices. Furthermore, if the Windows PC is connected via wired Ethernet (`192.168.1.10`) and the iPhone via 5GHz Wi-Fi (`192.168.2.15`), multicast DNS (mDNS) traffic often does not traverse VLAN/subnet boundaries without a multicast reflector.
* **Impact:**
  Pairing fails with a generic connection timeout or mDNS discovery failure.
* **Mitigation:**
  * Detect connection failures on the PWA (`app.js`) and surface diagnostic guidance to the user on mobile (e.g., *"Ensure AP Isolation is disabled on your router and both devices share the exact same subnet"*).

---

## 2. Clipboard Synchronization & Echo Guarding (`clipboard-monitor.js`)

### 2.1. Echo-Guard Window Race Conditions
* **Location:** [`src/main/clipboard-monitor.js:L9`](file:///d:/VSCode/QuickClip/src/main/clipboard-monitor.js#L9) (`ECHO_GUARD_MS = 1000`)
* **The Edge Case:**
  When QuickClip writes remote clipboard data from the iPhone (`writeToClipboard`), it suppresses clipboard monitoring for `1000 ms` to prevent infinite WebSocket loopbacks:
  ```javascript
  echoGuardUntil = Date.now() + ECHO_GUARD_MS;
  ```
  However, this introduces two race conditions:
  1. **Rapid Local Copy:** If the user rapidly copies text on their PC within `1000 ms` after a sync event, the local copy is silently discarded (`Date.now() < echoGuardUntil`).
  2. **Delayed Clipboard Manager Re-writes:** Third-party clipboard utilities (like Windows Cloud Clipboard `Win + V`, *Ditto*, or *1Password*) frequently re-inject or sanitize clipboard contents `1.2 to 2.0 seconds` after an external write. This falls outside the `1000 ms` guard and bounces the text back to the iPhone.
* **Mitigation:**
  * Replace fixed time-based guards (`ECHO_GUARD_MS`) with a **content-hash ring buffer**. Before broadcasting a local clipboard change over WebSockets, check if `md5(newContent)` matches any item received from the remote client within the last `10 seconds`.

---

### 2.2. Large Image Memory Spikes & Payload Stalls
* **Status: Fixed for bounded image processing and transfer.** Disabled image sync skips clipboard image reads. Polling and startup check dimensions before accessing pixels, and only changed, eligible images are encoded as PNG. Pixel fingerprints use native bitmap memory without copying it. Existing disk-backed images, metadata notifications, and authenticated image downloads keep full images out of WebSocket messages. Polling still reads and hashes eligible images every 500 ms; it is not event-driven. The description below records the original failure.
* **Location:** [`src/main/clipboard-monitor.js:L35-L52`](file:///d:/VSCode/QuickClip/src/main/clipboard-monitor.js#L35-L52) & `broadcastClipboard` in [`src/main/server.js:L155`](file:///d:/VSCode/QuickClip/src/main/server.js#L155)
* **The Edge Case:**
  If a Windows user takes a full-screen multi-monitor screenshot or copies an uncompressed 4K/8K bitmap image (`40+ MB raw memory`), `clipboard-monitor.js` converts the entire image into a base64 PNG payload.
* **Impact:**
  Broadcasting a massive base64 JSON payload over WebSocket (`ws://`) every `500 ms` can block the Node.js event loop on the Windows PC and cause memory crashes in mobile Safari on iOS due to aggressive per-tab RAM quotas.
* **Mitigation:**
  * Enforce maximum resolution/compression bounds when broadcasting images over WebSockets, or send only a lightweight metadata/thumbnail alert via WS and allow the PWA client to pull the full-res image via an authenticated HTTPS `GET /api/clipboard/latest-image` endpoint.

---

### 2.3. Complex & Binary Clipboard Formats (`CF_HDROP`)
* **Location:** `pollTimer` loop in [`src/main/clipboard-monitor.js`](file:///d:/VSCode/QuickClip/src/main/clipboard-monitor.js)
* **The Edge Case:**
  When users copy files in Windows Explorer (`Ctrl+C`), the clipboard is populated with `CF_HDROP` file paths rather than plain text (`clipboard.readText()`) or images (`clipboard.readImage()`). Similarly, copying formatted tables from Microsoft Excel includes rich HTML, RTF, and CSV payloads simultaneously.
* **Mitigation:**
  * Ensure the polling loop explicitly verifies clipboard format tokens (`clipboard.availableFormats()`) and gracefully ignores unsupported binary formats without generating empty history items or throwing unhandled errors.

---

## 3. High-Speed File Transfers & Disk Operations (`server.js` & `file-manager.js`)

### 3.1. iOS Safari Background Suspension During Large Uploads
* **Location:** [`src/main/server.js:L134-L140`](file:///d:/VSCode/QuickClip/src/main/server.js#L134-L140) (`multer.memoryStorage()`)
* **The Edge Case:**
  When transferring a large file (`500 MB` video from iPhone Camera Roll), if the user switches apps or locks their screen on iOS midway through the upload, Safari immediately suspends background network activity and drops the WebSocket/HTTPS stream.
* **Impact:**
  Because `multer.memoryStorage()` buffers the entire file in RAM before passing it to `fileManager.saveFile()`, dropped connections cause the entire buffer to be lost, requiring the user to restart the upload from 0%. Additionally, buffering `500 MB` directly in RAM can trigger Node.js out-of-memory crashes on low-spec PCs.
* **Mitigation:**
  * Switch `multer` from `memoryStorage()` to `diskStorage()` so chunks are streamed directly to disk (`data/received/.tmp/`) with minimal RAM overhead.
  * Implement resumable HTTP range uploads (`Tus.io` pattern or custom offset tracking) so interrupted transfers can resume exactly where Safari dropped them.

---

### 3.2. Filename Collisions & Path Traversal
* **Location:** [`src/main/file-manager.js`](file:///d:/VSCode/QuickClip/src/main/file-manager.js)
* **The Edge Case:**
  If an uploaded file contains relative path characters (`../../Windows/System32/cmd.exe`) or if multiple files share identical generic names (`IMG_0001.JPG`), standard file writes can either overwrite existing data (`index.json` or previous transfers) or attempt path traversal outside the `data/received/` sandbox.
* **Mitigation:**
  * Sanitize all incoming filenames using `path.basename(req.file.originalname)`.
  * Append unique cryptographic hashes or UUID prefixes to stored files on disk (`UUID-IMG_0001.JPG`) while preserving original display names inside `index.json`.

---

## 4. Certificate Authority & Trust Management (`certificates.js`)

### 4.1. iOS Certificate Trust Revocation & Expiration
* **Status: Server certificate renewal fixed.** Startup renews certificates at or within 30 days of expiration, including already expired certificates, even if the IP is unchanged. Missing or unreadable certificate contents and missing server keys are also regenerated using the existing CA. Healthy certificates are reused. iOS resetting certificate trust remains a manual device setting; renewal does not restore revoked trust. The description below records the original failure.
* **Location:** [`src/main/certificates.js:L43`](file:///d:/VSCode/QuickClip/src/main/certificates.js#L43) (`validity: 3650`) & `serverCert` (`validity: 365`)
* **The Edge Case:**
  While the generated root CA (`ca.crt`) is valid for ~10 years, the per-IP server certificate (`server.crt`) is valid for `365 days`. When the server certificate expires—or if an iOS major version update resets user profiles under **Settings → General → About → Certificate Trust Settings**—Safari will block `wss://` WebSocket connections and show a *“This Connection is Not Private”* warning.
* **Mitigation:**
  * Check `serverCert` validity dates on startup in `certificates.js`. If within 30 days of expiration, auto-regenerate `server.crt` using the existing root `ca.key`.
  * If the PWA client detects SSL/WebSocket handshakes failing, display a banner prompting the user to re-verify Certificate Trust Settings in iOS.
