// app.js — SYNC live streaming client (premium / low-latency build)
// =============================================================================
//   Host captures PC/tab audio via getDisplayMedia (+ optional mic talk-over),
//   mixes through Web Audio, and sends ONE tuned WebRTC stream per guest.
//
//   ADVANCED COMMS / LOW-LATENCY TECHNIQUES (section 5/7):
//     • Opus SDP munging: stereo=1, maxaveragebitrate, useinbandfec=1, minptime=10
//     • Sender max-bitrate via RTCRtpSender.setParameters()
//     • Receiver de-jitter: jitterBufferTarget = 0 / playoutDelayHint = 0
//     • Live getStats() telemetry: est. latency, bitrate, packet-loss per peer
//
//   Plus: spectrum visualizer, QR join, typing indicator, system messages,
//   chat, reactions, moderation, latency dashboard, light/dark theme.
//
//   Sections: 1 theme 2 ws 3 clock 4 join 5 host(mix+tuning) 6 guest
//             7 signaling(+stats) 8 chat 9 reactions 10 peers/mod 11 viz/qr 12 helpers
// =============================================================================

const $ = (id) => document.getElementById(id);

let ws = null, clientId = null, role = 'guest', isHost = false, roomId = 'main';
let clockOffset = 0, bestRtt = Infinity, rttDisplay = 0;
const serverNow = () => performance.now() + clockOffset;
let bitrateKbps = 256;

// =========================================================================
// 1. THEME
// =========================================================================
function applyTheme(t) {
  const dark = t === 'dark';
  document.documentElement.classList.toggle('dark', dark);
  $('themeBtn').textContent = dark ? '◐' : '◑';
  try { localStorage.setItem('sync-theme', t); } catch {}
}
$('themeBtn').onclick = () => applyTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark');
applyTheme((() => { try { return localStorage.getItem('sync-theme') || 'light'; } catch { return 'light'; } })());

// =========================================================================
// 2. WEBSOCKET
// =========================================================================
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => { setConn(true, 'syncing'); startClock(); sendWS('join', { roomId, role, name: myName() }); };
  ws.onclose = () => { setConn(false, 'offline'); stopClock(); };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    ({
      'time:pong': onPong, joined: onJoined, peers: onPeers, 'peer-left': (x) => onPeerLeft(x.id),
      'host-left': onHostLeft, 'guest-ready': (x) => { if (isHost && localStream) makeOffer(x.id); },
      signal: onSignal, title: (x) => setTitle(x.title), live: (x) => onLive(x.on),
      chat: (x) => addChat(x.msg), react: (x) => popReaction(x.emoji),
      typing: onTyping, muted: (x) => onMuted(x.muted), kicked: onKicked,
    }[m.type] || (() => {}))(m);
  };
}
const sendWS = (type, p = {}) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type, ...p })); };
const myName = () => ($('nameInput').value || (role === 'host' ? 'Host' : 'Guest')).slice(0, 24);

// =========================================================================
// 3. NTP CLOCK SYNC
// =========================================================================
let clockTimer = null, burst = 0;
function startClock() {
  bestRtt = Infinity; burst = 0;
  const tick = () => { sendWS('time:ping', { t0: performance.now() }); burst++; clockTimer = setTimeout(tick, burst < 10 ? 250 : 2500); };
  tick();
}
const stopClock = () => { clearTimeout(clockTimer); clockTimer = null; };
function onPong({ t0, t1, t2 }) {
  const t3 = performance.now();
  const rtt = (t3 - t0) - (t2 - t1);
  const offset = ((t1 - t0) + (t2 - t3)) / 2;
  if (rtt < bestRtt) { bestRtt = rtt; clockOffset = offset; }
  rttDisplay = rttDisplay ? rttDisplay * 0.7 + rtt * 0.3 : rtt;
  $('rttVal').textContent = Math.max(0, rttDisplay).toFixed(0);
  $('offsetVal').textContent = (clockOffset >= 0 ? '+' : '') + clockOffset.toFixed(0);
  sendWS('ping:report', { rtt: Math.max(0, rttDisplay) });
}

// =========================================================================
// 4. JOIN
// =========================================================================
function onJoined(m) {
  clientId = m.clientId; isHost = m.isHost; role = m.role;
  clockOffset = m.serverTime - performance.now();
  setConn(true, 'online');
  $('lobby').classList.add('hidden'); $('app').classList.remove('hidden');
  $('roomTag').textContent = roomId;
  $('roleTag').textContent = isHost ? 'HOST' : 'GUEST';
  $('hostPanel').classList.toggle('hidden', !isHost);
  $('guestPanel').classList.toggle('hidden', isHost);
  $('chatHint').textContent = isHost ? 'You can mute / remove guests' : '';
  setTitle(m.title);
  (m.chat || []).forEach(addChat);
  onLive(m.live);
  initViz();
}
function setTitle(t) {
  if (t) { $('trackName').textContent = t; $('trackSub').textContent = isHost ? 'your stream' : 'from host'; }
  else { $('trackName').textContent = isHost ? 'Your room' : 'Not streaming'; $('trackSub').textContent = 'Waiting to begin'; }
  if (isHost && document.activeElement !== $('titleInput')) $('titleInput').value = t || '';
}
function onLive(on) {
  $('liveTag').classList.toggle('hidden', !on);
  $('liveTag').classList.toggle('flex', on);
  $('nowCard').classList.toggle('ring-live', on);
  if (!on && !isHost) $('trackSub').textContent = 'Host paused the stream';
}

// =========================================================================
// 5. HOST: capture + mic talk-over + Opus tuning
// =========================================================================
// ICE config: starts with a STUN default, overwritten by /config (adds TURN
// from the server's env). iceCandidatePoolSize pre-gathers candidates so the
// first connection sets up faster. bundlePolicy bundles media on one transport.
let RTC = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], bundlePolicy: 'max-bundle', iceCandidatePoolSize: 4 };
async function loadIceConfig() {
  try {
    const cfg = await (await fetch('/config', { cache: 'no-store' })).json();
    if (cfg.iceServers && cfg.iceServers.length) RTC = { ...RTC, iceServers: cfg.iceServers };
    if (!cfg.hasTurn) console.info('[SYNC] No TURN configured — cross-network guests may fail to connect. Set TURN_* env vars.');
  } catch { /* keep STUN default */ }
}
let actx = null;
let displayStream = null, micStream = null, localStream = null;
let pcGain = null, micGain = null, destNode = null;
const peers = new Map();           // guestId -> RTCPeerConnection
let micOn = false;

$('qualSel')?.addEventListener('change', () => { bitrateKbps = +$('qualSel').value; for (const pc of peers.values()) applySenderBitrate(pc); });
$('titleInput')?.addEventListener('change', () => sendWS('title', { title: $('titleInput').value }));

$('captureBtn').onclick = async () => {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 },
    });
    const at = stream.getAudioTracks();
    if (!at.length) {
      alert('No audio captured. Tick "Share tab audio" (YouTube tab) or "Share system audio" (Entire screen).');
      stream.getTracks().forEach((t) => t.stop()); return;
    }
    stream.getVideoTracks().forEach((t) => t.stop());
    displayStream = new MediaStream(at);

    actx = actx || new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    if (actx.state === 'suspended') await actx.resume();
    destNode = actx.createMediaStreamDestination();
    pcGain = actx.createGain(); pcGain.gain.value = 1;
    const pcSrc = actx.createMediaStreamSource(displayStream);
    pcSrc.connect(pcGain); pcGain.connect(destNode);
    localStream = destNode.stream;
    vizConnect(pcGain); // feed visualizer

    $('captureBtn').classList.add('hidden'); $('captureHelp').classList.add('hidden');
    $('stopShareBtn').classList.remove('hidden'); $('micRow').classList.remove('hidden');
    $('trackSub').textContent = 'sharing · ' + (at[0].label || 'PC audio');
    sendWS('live', { on: true });
    for (const p of lastPeers.values()) if (p.id !== clientId && p.role === 'guest') makeOffer(p.id);
    at[0].onended = stopShare;
  } catch (e) { if (e.name !== 'NotAllowedError') alert('Capture failed: ' + e.message); }
};
$('stopShareBtn').onclick = stopShare;
function stopShare() {
  if (displayStream) displayStream.getTracks().forEach((t) => t.stop());
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  displayStream = micStream = localStream = null; micOn = false;
  for (const pc of peers.values()) pc.close(); peers.clear();
  $('captureBtn').classList.remove('hidden'); $('captureHelp').classList.remove('hidden');
  $('stopShareBtn').classList.add('hidden'); $('micRow').classList.add('hidden');
  $('micBtn').textContent = 'Mic off'; $('micBtn').classList.remove('btn-grad');
  $('trackSub').textContent = 'Waiting to begin';
  sendWS('live', { on: false });
}
$('micBtn').onclick = async () => {
  if (!localStream) return;
  if (!micOn) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const micSrc = actx.createMediaStreamSource(micStream);
      micGain = actx.createGain(); micGain.gain.value = 1; micSrc.connect(micGain); micGain.connect(destNode);
      micOn = true; pcGain.gain.setTargetAtTime(0.25, actx.currentTime, 0.2);
      $('micBtn').textContent = '🎙️ Mic ON'; $('micBtn').classList.add('btn-grad');
    } catch { alert('Microphone access denied.'); }
  } else {
    if (micStream) micStream.getTracks().forEach((t) => t.stop()); micStream = null; micOn = false;
    pcGain.gain.setTargetAtTime(1, actx.currentTime, 0.2);
    $('micBtn').textContent = 'Mic off'; $('micBtn').classList.remove('btn-grad');
  }
};

// ---- Opus SDP munging for quality + low latency ----
function tuneOpusSDP(sdp) {
  // stereo, high bitrate, in-band FEC, small min packet time
  return sdp.replace(/a=fmtp:111 ([^\r\n]*)/, (full, params) => {
    const want = { stereo: '1', 'sprop-stereo': '1', maxaveragebitrate: String(bitrateKbps * 1000), useinbandfec: '1', usedtx: '0', minptime: '10' };
    const map = new Map(params.split(';').map((kv) => { const [k, v] = kv.split('='); return [k.trim(), v]; }));
    for (const k in want) map.set(k, want[k]);
    return 'a=fmtp:111 ' + [...map].map(([k, v]) => v === undefined ? k : `${k}=${v}`).join(';');
  });
}
async function applySenderBitrate(pc) {
  const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
  if (!sender) return;
  const p = sender.getParameters();
  if (!p.encodings || !p.encodings.length) p.encodings = [{}];
  p.encodings[0].maxBitrate = bitrateKbps * 1000;
  p.encodings[0].priority = 'high';
  try { await sender.setParameters(p); } catch {}
}

async function makeOffer(guestId) {
  if (!localStream) return;
  let pc = peers.get(guestId); if (pc) pc.close();
  pc = new RTCPeerConnection(RTC); peers.set(guestId, pc);
  for (const tr of localStream.getTracks()) pc.addTrack(tr, localStream);
  pc.onicecandidate = (e) => { if (e.candidate) sendWS('signal', { to: guestId, data: { candidate: e.candidate } }); };
  pc.onconnectionstatechange = () => { if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) { pc.close(); peers.delete(guestId); } };
  const offer = await pc.createOffer();
  offer.sdp = tuneOpusSDP(offer.sdp);
  await pc.setLocalDescription(offer);
  await applySenderBitrate(pc);
  sendWS('signal', { to: guestId, data: { sdp: pc.localDescription } });
}

// =========================================================================
// 6. GUEST: playback (+ de-jitter for low latency)
// =========================================================================
$('listenBtn').onclick = () => {
  const el = $('liveAudio'); el.muted = false; el.volume = parseFloat($('vol').value);
  el.play().then(() => { $('listenBtn').textContent = '🔊 Listening'; $('listenBtn').classList.remove('btn-grad'); $('listenBtn').classList.add('btn-soft'); $('latencyLine').classList.remove('hidden'); }).catch(() => {});
};
$('vol').addEventListener('input', () => { $('liveAudio').volume = parseFloat($('vol').value); });

// =========================================================================
// 7. WEBRTC SIGNALING + STATS TELEMETRY
// =========================================================================
async function onSignal({ from, data }) {
  if (isHost) {
    const pc = peers.get(from); if (!pc) return;
    if (data.sdp) { try { await pc.setRemoteDescription(data.sdp); } catch {} }
    else if (data.candidate) { try { await pc.addIceCandidate(data.candidate); } catch {} }
  } else {
    let pc = peers.get(from);
    if (!pc) {
      pc = new RTCPeerConnection(RTC); peers.set(from, pc);
      pc.ontrack = (e) => {
        const el = $('liveAudio'); el.srcObject = e.streams[0];
        // minimize receiver-side buffering -> closer to real-time
        try { const r = pc.getReceivers().find((x) => x.track.kind === 'audio'); if (r) { if ('jitterBufferTarget' in r) r.jitterBufferTarget = 0; if ('playoutDelayHint' in r) r.playoutDelayHint = 0; } } catch {}
        el.play().catch(() => {});
        $('trackSub').textContent = 'receiving — tap Listen if silent';
      };
      pc.onicecandidate = (e) => { if (e.candidate) sendWS('signal', { to: from, data: { candidate: e.candidate } }); };
    }
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      const a = await pc.createAnswer(); a.sdp = tuneOpusSDP(a.sdp); await pc.setLocalDescription(a);
      sendWS('signal', { to: from, data: { sdp: pc.localDescription } });
    } else if (data.candidate) { try { await pc.addIceCandidate(data.candidate); } catch {} }
  }
}

// poll getStats() for live telemetry (latency / bitrate / loss)
const statsPrev = new Map();
setInterval(async () => {
  for (const [id, pc] of peers) {
    if (pc.connectionState !== 'connected') continue;
    try {
      const stats = await pc.getStats();
      let rtt = null, jitter = null, loss = null, bytes = 0, ts = 0, packets = 0;
      stats.forEach((r) => {
        if (r.type === 'remote-inbound-rtp' && r.roundTripTime != null) rtt = r.roundTripTime * 1000;
        if (r.type === 'inbound-rtp' && r.kind === 'audio') { jitter = r.jitter != null ? r.jitter * 1000 : null; bytes = r.bytesReceived || 0; ts = r.timestamp; packets = r.packetsLost || 0; }
        if (r.type === 'candidate-pair' && r.nominated && r.currentRoundTripTime != null && rtt == null) rtt = r.currentRoundTripTime * 1000;
      });
      const prev = statsPrev.get(id);
      let kbps = null;
      if (prev && ts > prev.ts) kbps = ((bytes - prev.bytes) * 8) / (ts - prev.ts); // bits per ms = kbps
      statsPrev.set(id, { bytes, ts, packets });
      peerStats.set(id, { rtt, jitter, kbps, loss: packets });
      if (!isHost) {
        // guest shows its own est. mouth-to-ear latency ≈ rtt/2 + jitter + ~playout
        const est = (rtt != null ? rtt / 2 : 0) + (jitter || 0) + 20;
        $('latencyLine').textContent = `≈ ${est.toFixed(0)} ms latency · ${kbps ? kbps.toFixed(0) + ' kbps' : '—'} · jitter ${jitter != null ? jitter.toFixed(0) : '—'} ms`;
      }
    } catch {}
  }
  if (isHost) renderPeerStats();
}, 1500);
const peerStats = new Map();

// =========================================================================
// 8. CHAT (+ typing indicator + system messages)
// =========================================================================
function sendChat() {
  const t = $('chatInput').value.trim(); if (!t) return;
  sendWS('chat', { text: t }); $('chatInput').value = ''; sendTyping(false);
}
$('chatSend').onclick = sendChat;
let typingSent = false, typingTimer = null;
$('chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
$('chatInput').addEventListener('input', () => {
  sendTyping(true);
  clearTimeout(typingTimer); typingTimer = setTimeout(() => sendTyping(false), 1500);
});
function sendTyping(on) { if (on !== typingSent) { typingSent = on; sendWS('typing', { on }); } }
const typers = new Set();
function onTyping({ name, on }) {
  if (on) typers.add(name); else typers.delete(name);
  const arr = [...typers];
  $('typingRow').classList.toggle('hidden', arr.length === 0);
  $('typingText').textContent = arr.length === 1 ? `${arr[0]} is typing` : arr.length > 1 ? `${arr.length} people typing` : '';
}
let muted = false;
function onMuted(m) { muted = m; $('chatInput').disabled = m; $('chatInput').placeholder = m ? 'You were muted by the host' : 'Message…'; }
function addChat(msg) {
  const list = $('chatList');
  const li = document.createElement('li');
  if (msg.role === 'system') {
    li.className = 'text-center'; li.innerHTML = `<span class="muted text-[11px] italic">${escapeHtml(msg.text)}</span>`;
  } else {
    li.className = 'leading-snug';
    li.innerHTML = `<span class="font-bold ${msg.role === 'host' ? 'text-accent' : ''}">${escapeHtml(msg.name)}</span>
      <span class="muted text-[10px] ml-1">${time(msg.ts)}</span><br><span class="break-words">${escapeHtml(msg.text)}</span>`;
  }
  list.appendChild(li);
  while (list.children.length > 200) list.removeChild(list.firstChild);
  list.scrollTop = list.scrollHeight;
}

// =========================================================================
// 9. REACTIONS
// =========================================================================
document.querySelectorAll('.reactBtn').forEach((b) => b.onclick = () => sendWS('react', { emoji: b.dataset.e }));
function popReaction(emoji) {
  const el = document.createElement('div');
  el.className = 'react'; el.textContent = emoji; el.style.left = (8 + Math.random() * 78) + '%';
  document.body.appendChild(el); setTimeout(() => el.remove(), 2400);
}

// =========================================================================
// 10. PEERS / MODERATION / ANALYTICS
// =========================================================================
let lastPeers = new Map();
function onPeers({ peers: list, count, listeners }) {
  lastPeers = new Map(list.map((p) => [p.id, p]));
  $('peerCount').textContent = `(${count})`;
  $('listenCount').textContent = `${listeners} live`;
  renderPeers(list);
  if (isHost && localStream) for (const p of list) if (p.id !== clientId && p.role === 'guest' && !peers.has(p.id)) makeOffer(p.id);
}
function renderPeers(list) {
  list = list || [...lastPeers.values()];
  $('peerList').innerHTML = list.map((p) => {
    const ping = p.ping == null ? '—' : p.ping;
    const col = p.ping == null ? 'muted' : p.ping < 50 ? 'text-emerald-500' : p.ping < 130 ? 'text-amber-500' : 'text-red-500';
    const st = peerStats.get(p.id);
    const bars = qualityBars(p.ping, st);
    const modBtns = (isHost && p.role !== 'host')
      ? `<button data-mute="${p.id}" class="text-[11px] btn-soft rounded-md px-1.5 py-0.5">${p.muted ? 'unmute' : 'mute'}</button>
         <button data-kick="${p.id}" class="text-[11px] rounded-md px-1.5 py-0.5 text-red-500 hover:bg-red-500/10">kick</button>` : '';
    return `<li class="flex items-center justify-between rounded-lg px-2.5 py-2 hover:bg-black/[.03] dark:hover:bg-white/[.04]">
      <span class="flex items-center gap-2 min-w-0">
        <span class="w-1.5 h-1.5 rounded-full ${p.role === 'host' ? 'bg-accent' : 'bg-emerald-500'} dot shrink-0"></span>
        <span class="font-semibold truncate">${escapeHtml(p.name)}</span>${p.id === clientId ? '<span class="muted text-[10px]">(you)</span>' : ''}
        ${p.muted ? '<span class="text-[10px] text-amber-500">muted</span>' : ''}
      </span>
      <span class="flex items-center gap-2 shrink-0">
        ${bars}
        <span class="font-mono text-[11px] ${col}">${ping}<span class="muted">ms</span></span>
        ${modBtns}
      </span></li>`;
  }).join('');
  if (isHost) {
    $('peerList').querySelectorAll('[data-mute]').forEach((b) => b.onclick = () => { const p = lastPeers.get(b.dataset.mute); sendWS('mute', { id: b.dataset.mute, muted: !p?.muted }); });
    $('peerList').querySelectorAll('[data-kick]').forEach((b) => b.onclick = () => sendWS('kick', { id: b.dataset.kick }));
  }
}
const renderPeerStats = () => renderPeers();
function qualityBars(ping, st) {
  let level = 0;
  const v = st && st.rtt != null ? st.rtt : ping;
  if (v == null) level = 0; else if (v < 60) level = 4; else if (v < 120) level = 3; else if (v < 220) level = 2; else level = 1;
  const col = level >= 4 ? 'text-emerald-500' : level >= 3 ? 'text-lime-500' : level >= 2 ? 'text-amber-500' : 'text-red-500';
  let bars = ''; for (let i = 1; i <= 4; i++) bars += `<i class="${i <= level ? 'on' : ''}" style="height:${i * 25}%"></i>`;
  return `<span class="qual ${col}">${bars}</span>`;
}
function onPeerLeft(id) { const pc = peers.get(id); if (pc) { pc.close(); peers.delete(id); } peerStats.delete(id); statsPrev.delete(id); }
function onKicked() { alert('You were removed from the room by the host.'); location.reload(); }

// =========================================================================
// 11. SPECTRUM VISUALIZER + QR
// =========================================================================
let viz, vctx, analyser, freq, vizReady = false;
function initViz() {
  viz = $('viz'); vctx = viz.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const resize = () => { viz.width = viz.clientWidth * dpr; viz.height = viz.clientHeight * dpr; };
  resize(); window.addEventListener('resize', resize);
  requestAnimationFrame(drawViz);
}
function vizConnect(node) {
  if (!actx) actx = node.context;
  analyser = actx.createAnalyser(); analyser.fftSize = 128; analyser.smoothingTimeConstant = 0.78;
  freq = new Uint8Array(analyser.frequencyBinCount); node.connect(analyser); vizReady = true;
}
// guests: attach analyser to the <audio> element once playing
function ensureGuestViz() {
  if (vizReady || isHost) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const src = actx.createMediaStreamSource($('liveAudio').srcObject);
    vizConnect(src);
  } catch {}
}
function drawViz() {
  requestAnimationFrame(drawViz);
  if (!vctx) return;
  const w = viz.width, h = viz.height;
  vctx.clearRect(0, 0, w, h);
  if (!vizReady) { ensureGuestViz(); }
  if (!analyser) return;
  analyser.getByteFrequencyData(freq);
  const n = freq.length, bw = w / n;
  for (let i = 0; i < n; i++) {
    const v = freq[i] / 255;
    const bh = Math.max(2, v * h);
    const hue = 250 - v * 80; // indigo->pink as it gets loud
    vctx.fillStyle = `hsl(${hue},85%,${document.documentElement.classList.contains('dark') ? 62 : 55}%)`;
    vctx.fillRect(i * bw, h - bh, bw * 0.7, bh);
  }
}
$('qrBtn').onclick = () => {
  const lan = location.host; // if host opened localhost, suggest they swap to LAN IP for the QR
  const url = `${location.protocol}//${lan}/?room=${encodeURIComponent(roomId)}`;
  $('qrRoom').textContent = roomId; $('qrUrl').textContent = url;
  $('qrBox').innerHTML = '';
  if (window.QRCode) QRCode.toCanvas(url, { width: 200, margin: 1 }, (err, canvas) => { if (!err) $('qrBox').appendChild(canvas); });
  if (/localhost|127\.0\.0\.1/.test(lan)) $('qrUrl').textContent = url + '  ⚠️ swap localhost→your LAN IP for phones';
  $('qrModal').classList.remove('hidden');
};

// =========================================================================
// 12. LOBBY / HELPERS
// =========================================================================
$('hostBtn').onclick = () => { role = 'host'; enter(); };
$('guestBtn').onclick = () => { role = 'guest'; enter(); };
async function enter() { roomId = ($('roomInput').value || 'main').trim().toLowerCase(); await loadIceConfig(); connect(); }
$('leaveBtn').onclick = () => location.reload();
function onHostLeft() {
  for (const pc of peers.values()) pc.close(); peers.clear();
  $('liveAudio').srcObject = null; onLive(false);
  $('trackName').textContent = 'Host left'; $('trackSub').textContent = 'The stream ended';
}
// prefill room from ?room= (QR deep link)
(() => { const r = new URLSearchParams(location.search).get('room'); if (r) $('roomInput').value = r; })();

function setConn(on, t) { $('connDot').className = `inline-block w-1.5 h-1.5 rounded-full mr-1.5 align-middle ${on ? 'bg-emerald-500 dot' : 'bg-zinc-400'}`; $('connText').textContent = t; }
const time = (ts) => { const d = new Date(Date.now() - (serverNow() - ts)); return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
