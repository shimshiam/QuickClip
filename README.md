# QuickClip

<div align="center">

![QuickClip Banner](./assets/demo-banner.png)

**Instantaneous, secure local-network clipboard & file sharing between Windows PCs and iPhone.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Platform: Windows & iOS](https://img.shields.io/badge/Platform-Windows%20%7C%20iOS-4F46E5.svg)]()
[![Built With: Electron & Express](https://img.shields.io/badge/Built%20With-Electron%20%7C%20Node.js%20%7C%20WebSockets-06B6D4.svg)]()

</div>

---

## 📖 Overview

**QuickClip** bridges the gap between Windows desktops and Apple iOS devices. While Mac users enjoy Apple's native Continuity and Handoff features, Windows users have historically lacked a seamless, native-feeling way to instantly copy text, share clipboard images, or transfer files across devices without resorting to cloud storage apps, emailing themselves, or messaging self-chats.

QuickClip solves this by running a secure **HTTPS + WebSocket server** directly inside an **Electron desktop app** on your Windows PC. Your iPhone connects locally over your home or office Wi-Fi via an optimized **Progressive Web App (PWA)**—enabling instantaneous, encrypted bidirectional syncing with zero cloud dependencies.

---

## 🌟 Why QuickClip is Beneficial

> [!IMPORTANT]
> **Zero Cloud Dependency & Complete Privacy**  
> Every single byte of text, image data, and file transfer stays 100% within your Local Area Network (LAN). No data ever touches third-party servers, cloud storage providers, or external databases.

* 🚀 **Instantaneous Apple-to-Windows Handoff:** Copy text or images on your Windows PC and watch them immediately appear on your iPhone screen, and vice versa—powered by real-time WebSockets with zero polling delays.
* 🔒 **End-to-End Local HTTPS Encryption:** By automatically generating a local Certificate Authority (CA) using `mkcert`, QuickClip ensures that your local web traffic (`https://your-ip:8443`) is fully encrypted and trusted by iOS without annoying browser security warnings.
* 📲 **Native PWA Experience:** QuickClip installs directly to your iPhone Home Screen as a standalone Progressive Web App with custom icons, full-screen viewport support, and fast native-like responsiveness.
* ⚡ **Zero-Configuration Pairing:** Simply scan the QR code displayed on your Windows app with your iPhone camera. QuickClip handles authentication using cryptographic pairing tokens and discovers services automatically via **Bonjour / mDNS**.
* 📁 **High-Speed Local File Transfers:** Transfer photos, videos, documents, and archives up to **500 MB** directly across Wi-Fi at local network gigabit speeds—bypassing internet bandwidth limits entirely.
* 🖥️ **Unobtrusive System Tray Integration:** Runs quietly in the background on Windows with smart clipboard monitoring, thumbnail previews, echo guards, and one-click tray controls.

---

## 📸 Demo & Screenshots

> [!NOTE]
> *The images below are placeholders for demo screenshots and GIFs illustrating QuickClip in action.*

### 1. Windows Desktop Pairing & QR Code
Scan the dynamic QR code on your PC to instantly authenticate and link your iPhone.

![Windows Desktop Pairing & QR Code](./assets/demo-pairing.png)

### 2. Real-Time Clipboard Sync
Text and images copied on Windows immediately appear in your iPhone's QuickClip PWA feed ready to be copied or shared.

![Real-Time Clipboard Sync](./assets/demo-clipboard-sync.png)

### 3. Bidirectional High-Speed File Transfer
Send files from your iPhone to QuickClip's per-user `runtime/received` folder, or download files shared from your PC.

![Bidirectional File Transfer](./assets/demo-file-transfer.png)

---

## 🏗️ Architecture & How It Works

```mermaid
graph TD
    subgraph Windows PC ["Windows PC (Electron App)"]
        CM[Clipboard Monitor] <--> IPC[Electron IPC / State]
        FM[File Storage Manager] <--> IPC
        IPC <--> WS[WebSocket Server :8443]
        IPC <--> HTTPS[Express HTTPS Server :8443]
        CA[mkcert Local CA] --> HTTPS
        MDNS[Bonjour mDNS Service]
    end

    subgraph iPhone ["iPhone (iOS PWA / Safari)"]
        QR[Camera / QR Code Scanner]
        PWA[QuickClip PWA UI]
        PWA <-->|WSS Real-Time Events| WS
        PWA <-->|HTTPS REST & Files| HTTPS
    </main>

    QR -->|Reads Server URL + Token| MDNS
    QR -->|Initial Pairing| HTTPS
```

---

## 🛠️ Prerequisites

Before installing QuickClip, ensure your system meets the following requirements:

* **Operating System:** Windows 10 or Windows 11 (64-bit)
* **Node.js:** v18.x or newer ([Download Node.js](https://nodejs.org/))
* **Git:** Installed on your PC
* **Network:** Windows PC and iPhone connected to the **same Wi-Fi / Local Network** (with client isolation/AP isolation disabled on your router).

---

## 📥 Installation Guide

### Step 1: Clone the Repository & Install Dependencies

Open PowerShell or your preferred terminal on Windows and run:

```bash
# Clone the QuickClip repository
git clone https://github.com/yourusername/QuickClip.git
cd QuickClip

# Install Node dependencies
npm install
```

### Step 2: Launch QuickClip on Windows

Start the desktop application:

```bash
# Start in standard production mode
npm start

# OR run in development mode (includes dev tooling)
npm run dev
```

On first launch, QuickClip will automatically:
1. Migrate existing project data into the per-user application-data folder, preserving pairing and certificates. Generate certificates in `runtime/certs/` on first use.
2. Start the HTTPS and WebSocket server on port `8443`.
3. Broadcast the QuickClip service across your network via Bonjour (`.local`).
4. Display the main dashboard with your unique QR code.

---

## 📱 iPhone Setup & One-Time Pairing

To allow your iPhone to trust the local HTTPS connection and enjoy seamless syncing, complete this simple **one-time** setup:

### 1. Download & Install the Local CA Certificate
1. Make sure your iPhone and PC are on the same Wi-Fi network.
2. On your Windows QuickClip window, click the **Download CA Certificate** button, or navigate directly to `https://<your-pc-ip>:8443/ca.crt` in Safari on your iPhone.
3. When prompted by Safari, tap **Allow** to download the configuration profile.

### 2. Trust the Certificate in iOS Settings
1. Open your iPhone **Settings** app. You will see a prompt saying **Profile Downloaded** at the top—tap it (or navigate to **General → VPN & Device Management** → select **QuickClip CA**).
2. Tap **Install** in the top-right corner, enter your passcode, and confirm installation.
3. Next, navigate to **Settings → General → About → Certificate Trust Settings**.
4. Under **Enable Full Trust for Root Certificates**, toggle the switch next to **QuickClip CA** to **ON** and confirm.

> [!TIP]
> **Why is this necessary?**  
> Apple requires explicit user trust for self-signed certificates. Enabling this allows Safari and the PWA to connect over secure HTTPS and WebSockets (`wss://`) without showing security errors. You only need to perform this step **once per device**.

### 3. Pair & Add to Home Screen
1. Open your iPhone Camera app and **scan the QR code** shown on your Windows desktop screen.
2. Tap the notification to open QuickClip in Safari. You will instantly connect!
3. To install as a native app: tap the **Share button** (square with an up arrow) in Safari and select **Add to Home Screen**.
4. Launch **QuickClip** directly from your Home Screen anytime you want to share clipboard contents or files!

---

## ⚙️ Configuration & Data Storage

QuickClip stores runtime data in `app.getPath('userData')/runtime`, normally `%APPDATA%/quickclip/runtime` on Windows:

| Directory / File | Description |
| :--- | :--- |
| `runtime/config.json` | Pairing token and validated preferences. |
| `runtime/certs/` | Existing CA, server certificates, and private keys. |
| `runtime/received/` | Files shared in either direction. |
| `runtime/received/index.json` | Metadata and local paths for shared files. |
| `runtime/clipboard-images/` | Full-resolution images for the current clipboard-history session. |

On the first launch after updating, QuickClip copies and verifies the old project `data/` folder, rewrites indexed file paths, and only then activates the new location. The original folder is retained as a recovery copy. Failed migrations stop startup with an error instead of replacing the original configuration. Index entries whose files were already missing are retained as unavailable and listed in `runtime/migration.json`; they do not block migration of intact files. Successful migrations do not rotate the pairing token or CA; no certificate reinstall is normally needed. Keep both copies private. Clipboard history remains session-only; its image files are removed when entries expire, history is cleared, or the app exits. Received files are retained.

### Transfer confirmation and limits

The phone displays **Sending…** until Windows confirms the clipboard write. A disconnected or timed-out transfer displays **Delivery not confirmed** and a Retry button. Retry uses the same transfer ID and is available for five minutes; Windows retains up to 1,000 successful IDs for ten minutes during its current session to prevent duplicate writes after reconnecting. A Windows restart clears those receipts.

Text is limited to 1 MiB of UTF-8 data. Clipboard images must be PNG or JPEG, at most 20 MiB compressed and after PNG conversion, and at most 40 megapixels. Larger images can be sent as regular files (up to 500 MiB). The limits can be lowered with `maxTextBytes` and `maxImageBytes` in `runtime/config.json` while QuickClip is closed. History holds 1–200 items, with 50 as the default; interfaces load thumbnails and fetch full images only for Copy. Old images may become unavailable when Windows prunes history.

Text, image, and file preferences govern new transfers in both directions. Tray **Pause Sync** pauses all new transfers. Existing history and previously received files remain available. Phone uploads interrupted by backgrounding or a ten-minute timeout must be retried manually; check Windows before resending a file because file uploads do not have clipboard-style deduplication.

Browser requests must originate from the QuickClip server's own HTTPS origin. REST requests use Bearer authentication; downloads use file-scoped links that expire after 60 seconds. Pairing QR codes contain a browser URL with credentials in its fragment, which is removed after saving the pairing. WebSocket authentication still uses the pairing token in its handshake URL. Do not share pairing links or server logs containing credentials.

After updating, fully quit and restart Windows QuickClip and reload the phone page so both use the updated protocol. No token or certificate rotation is automatic. If private credentials have been exposed, replace them deliberately and re-pair; replacing the CA also requires installing and trusting it on the phone.

### Verification

Run `npm test` for transport, validation, settings, retry, migration, and history-storage tests. Run `npm run test:electron` for an isolated Electron check of PNG decoding, rendered phone/desktop interfaces, confirmed transfers, full-resolution Copy, pause/resume, and history reload. The Electron check uses hidden windows, temporary certificates, and a simulated clipboard; it does not read or change your system clipboard. Test screenshots are saved under `.test-output/`. Final iPhone verification should include sending text and an image, copying a history image after a reload, uploading/downloading a file, and reconnecting after locking the phone.

---

## ❓ Troubleshooting & FAQs

<details>
<summary><strong>My iPhone stays on "Connecting..." or cannot find the PC</strong></summary>

* Check that both your Windows PC and your iPhone are on the **exact same Wi-Fi network**.
* Check if your router has **Guest Mode** or **AP Isolation** enabled; these prevent local devices from communicating with each other.
* Ensure **Windows Defender Firewall** is not blocking Node.js or Electron. You can allow port `8443` (TCP) and `5353` (UDP for mDNS) in Windows Security settings:
  1. Open **Windows Security → Firewall & network protection → Allow an app through firewall**.
  2. Ensure `node.exe` or `electron.exe` has checkmarks for **Private** networks.
</details>

<details>
<summary><strong>Safari says "This Connection is Not Private"</strong></summary>

* This happens if the QuickClip CA certificate is not trusted yet. Make sure you completed both step 2 (installing the profile under `General → VPN & Device Management`) AND step 3 (enabling full trust under `General → About → Certificate Trust Settings`).
</details>

<details>
<summary><strong>What happens if my PC's LAN IP address changes?</strong></summary>

* QuickClip automatically checks your LAN IP on startup. If your IP changes (for example, from `192.168.1.42` to `192.168.1.55`), QuickClip will automatically regenerate the server certificate for the new IP while preserving your root CA. Simply re-scan the QR code on your iPhone to update the connection URL.
</details>

---

## 📜 License

Distributed under the **MIT License**. See `LICENSE` for more information.
