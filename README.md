# ◉ SYNC — live audio rooms

A premium, minimal web app for **live audio streaming to a crowd**. One host shares whatever is playing on their PC — **Spotify, YouTube, any app** — and can **talk over it like a radio DJ**. Guests open a URL and listen in sync, with **live chat, emoji reactions, and a real-time latency dashboard**. Runs entirely in the browser — no native apps, no file uploads.

- **Backend:** Node.js + Express + `ws` (signaling + rooms only)
- **Frontend:** HTML5 + Tailwind + Web Audio + WebRTC (vanilla JS)
- **Design:** minimal, single-accent, **light by default with a dark toggle** — no gradients.

---

## ☁️ Deploy to the cloud (Render — 1 click)

**Vercel / Netlify won't work** — they're serverless and can't hold the persistent WebSocket + in-memory rooms this app needs. Use a host that runs a real Node process. **Render** has a free tier and your code deploys unchanged:

1. Push this repo to **GitHub**.
2. On **render.com** → **New → Blueprint** → select the repo (it reads `render.yaml`). Or **New → Web Service**, build `npm install`, start `npm start`.
3. Open the `https://…onrender.com` URL. **Bonus:** because it's HTTPS, the **host no longer needs `localhost`** — audio capture works from the public URL.

### ⚠️ Cross-network guests need TURN
On the **same Wi-Fi**, STUN is enough (default). Once host & guests are on **different networks**, NAT/firewalls block direct P2P and you need a **TURN relay**. Get free creds from **metered.ca** or **Twilio**, or self-host **coturn**, then set these env vars (Render dashboard or `render.yaml`):

```
TURN_URL=turn:your.turn.host:3478
TURN_URL2=turns:your.turn.host:5349   # optional TLS
TURN_USER=username
TURN_PASS=password
```

The server exposes them to clients via `GET /config` (no secrets in the frontend code). With no TURN set, it logs a console hint and falls back to STUN.

### Speed optimizations baked in
- **gzip/brotli** compression + cache headers on static assets (faster first load).
- **`iceCandidatePoolSize`** pre-gathers ICE candidates → faster first connection.
- Plus the per-stream Opus tuning & receiver de-jitter (see Features).

---

## ⚠️ Running locally — host must open `localhost`

Capturing the PC's audio (`getDisplayMedia`) only works in a **secure context**: `https://` (cloud) or `localhost` (local).

| Device | Open this URL | Browser |
|---|---|---|
| **Host (your PC)** | **`http://localhost:3000`** | **Chrome / Edge** (desktop) |
| **Guests (phones, etc.)** | `http://192.168.x.x:3000` (printed in console) | any modern browser, incl. iOS Safari |

Guests only *receive*, so plain HTTP over the LAN is fine for them.

---

## Features

- 🔊 **Live PC/tab audio streaming** — share Spotify / YouTube / system audio to every guest over WebRTC.
- 🎚️ **Audio quality selector** — 128 / 256 (stereo) / 320 kbps, applied live.
- 🎙️ **Host mic talk-over** — speak over the music; it auto-**ducks** to 25% while your mic is on (mixed via Web Audio).
- 📊 **Live spectrum visualizer** — real-time FFT bars driven by the actual stream (host + guest).
- 💬 **Live chat** — real-time, named, backlog for late joiners, **typing indicators**, and **join/left system messages**.
- 🎉 **Emoji reactions** — floating Twitch-style 🔥❤️👏🎉😂🙌 for the whole room.
- 🏷️ **Stream title** + **🛡️ moderation** (mute / kick) + live **listener count**.
- 📡 **Latency dashboard** — NTP clock sync ping per guest + **WebRTC `getStats()` telemetry** (est. mouth-to-ear latency, live bitrate, jitter) and signal-quality bars.
- 🔳 **QR join code** — guests scan to join (deep-links the room via `?room=`).
- 🌗 **Light / dark theme** — premium glassmorphism, persisted.

### Low-latency / advanced comms techniques
- **Opus SDP munging** on offer & answer: `stereo=1; sprop-stereo=1; maxaveragebitrate=<q>; useinbandfec=1; usedtx=0; minptime=10` — stereo, high bitrate, packet-loss-resilient, tight packet cadence.
- **Sender max-bitrate** via `RTCRtpSender.setParameters()` (`maxBitrate`, `priority:'high'`).
- **Receiver de-jitter**: `jitterBufferTarget = 0` / `playoutDelayHint = 0` to push playout toward real-time (the biggest mouth-to-ear win).
- **`AudioContext({latencyHint:'interactive'})`** and `bundlePolicy:'max-bundle'`.
- **Live `getStats()`** polled every 1.5 s for RTT, jitter, bitrate and loss, surfaced in the UI.

---

## How it works

1. **Clock sync (dashboard):** each client runs an NTP-style ping (`RTT` + `offset = serverClock − localClock`), keeping the lowest-RTT sample. This powers the per-guest ping readout.
2. **Audio mix (host):** `getDisplayMedia` captures PC/tab audio. It's routed through a Web Audio graph: `PC audio → pcGain ─┐`, `mic → micGain ─┴→ MediaStreamDestination`. Turning the mic on ramps `pcGain` down (ducking). The destination's stream is what guests receive.
3. **Distribution:** the host creates **one `RTCPeerConnection` per guest** and sends the mixed audio track. Signaling (offer/answer/ICE) is relayed through the server's WebSocket; **media flows host→guest peer-to-peer**.
4. **Chat / reactions / moderation / title** are small JSON messages fanned out by the server; chat keeps a 100-message ring buffer so new guests get context.

> **Latency note:** live WebRTC audio is ~100–300 ms end-to-end — inherent to live streaming (you can't pre-buffer a live source). All guests stay close to each other.

---

## Run it

```bash
npm install
npm start
```
```
  ◉  SYNC — live audio
    Host (this PC):  http://localhost:3000
    Guests:          http://192.168.x.x:3000
```

### Host (your PC)
1. Open **`http://localhost:3000`** → enter a room code → **Host**.
2. (Optional) type a **stream title**.
3. **Start sharing PC audio** → in the popup:
   - **YouTube** → pick the **Tab** + tick **“Share tab audio.”**
   - **Spotify app** → pick **Entire screen** + tick **“Share system audio.”**
4. Play your music. Toggle **🎙️ Mic ON** to talk over it.

### Guests (phones)
1. Same Wi-Fi → open the **Guests** URL → same room code → **Join**.
2. Tap **Tap to listen** (mobile autoplay needs one tap), adjust volume, chat, react.

---

## Troubleshooting

- **“No audio captured.”** Open the host page via **`localhost`** (not the IP), and **tick the audio checkbox** in the share dialog (tab audio / system audio).
- **Phone can't reach the URL?** Disable **AP / client isolation** on your Wi-Fi; allow **Node.js through Windows Firewall** on **Private** networks; keep both devices on the same SSID.
- **iOS guest silent?** Tap **Tap to listen** after joining (autoplay policy).
- **Guest hears nothing but is "connected"?** Some routers block direct P2P; for fully remote guests you'd add a TURN server to `RTC.iceServers` in `app.js`. On a normal LAN, STUN is enough.
- **macOS host:** browser-tab audio capture works; full system-audio capture is limited by the OS.

## Scaling
Each live guest is a **separate Opus encode on the host** (CPU + uplink). On a laptop + home Wi-Fi, ~10–20 guests is comfortable; for larger crowds you'd introduce an SFU (e.g. mediasoup) — out of scope here. WebSocket chat/reactions cost is negligible.

## Layout
```
Sync/
├── server.js          # Express + ws: rooms, signaling, chat, moderation, clock
├── package.json       # express + ws only
└── public/
    ├── index.html     # minimal premium UI, light/dark
    └── app.js         # clock sync, host mix+mic, WebRTC, chat, reactions, theme
```
