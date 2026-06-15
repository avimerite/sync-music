// server.js — SYNC live streaming backend
// =============================================================================
// A host shares this PC's audio (Spotify / YouTube / any app, + optional mic
// talk-over) and every guest listens live over WebRTC. The Node server is the
// signaling + room coordinator only — media flows host -> guest peer-to-peer.
//
// Responsibilities:
//   • Serve the static frontend.
//   • Authoritative NTP-style clock (for the latency dashboard).
//   • Rooms: one host, many guests.
//   • WebRTC signaling relay (host audio stream -> each guest).
//   • Live chat, emoji reactions, stream title.
//   • Host moderation: mute (block from chat) + kick.
//   • Per-guest ping analytics fanned to the host.
// =============================================================================

import express from 'express';
import compression from 'compression';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const EPOCH_ANCHOR = Date.now() - performance.now();
const serverNow = () => EPOCH_ANCHOR + performance.now();

const app = express();
app.disable('x-powered-by');
app.use(compression());                       // gzip/br -> faster first load
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  setHeaders: (res, p) => { if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); },
}));

// ICE config for the client. TURN is read from env so no secrets in code.
// Set TURN_URL / TURN_USER / TURN_PASS (and optional TURN_URL2) on your host.
app.get('/config', (req, res) => {
  const ice = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) {
    const urls = [process.env.TURN_URL];
    if (process.env.TURN_URL2) urls.push(process.env.TURN_URL2);
    ice.push({ urls, username: process.env.TURN_USER || '', credential: process.env.TURN_PASS || '' });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json({ iceServers: ice, hasTurn: !!process.env.TURN_URL });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---------------------------------------------------------------------------
// Room model
// ---------------------------------------------------------------------------
/**
 * room = {
 *   hostId,
 *   title: string,                 // stream title / now-playing text
 *   live: bool,                    // host is actively sharing audio
 *   clients: Map<id, { ws, role, name, ping, muted }>,
 *   chat: [{ name, text, ts, role }]   // small ring buffer for late joiners
 * }
 */
const rooms = new Map();
function getRoom(id) {
  if (!rooms.has(id))
    rooms.set(id, { hostId: null, title: '', live: false, clients: new Map(), chat: [] });
  return rooms.get(id);
}

const send = (ws, type, p = {}) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...p })); };
function broadcast(room, type, p, exceptId = null) {
  for (const [id, c] of room.clients) if (id !== exceptId) send(c.ws, type, p);
}
const peerList = (room) =>
  [...room.clients.entries()].map(([id, c]) => ({ id, name: c.name, role: c.role, ping: c.ping ?? null, muted: !!c.muted }));
const notifyPeers = (room) =>
  broadcast(room, 'peers', { peers: peerList(room), count: room.clients.size, listeners: [...room.clients.values()].filter((c) => c.role === 'guest').length });

function snapshot(room) {
  return { title: room.title, live: room.live, chat: room.chat.slice(-50) };
}

// Push an ephemeral system line ("X joined") into the chat stream.
function sysMessage(room, text, exceptId = null) {
  const entry = { name: '', text, ts: serverNow(), role: 'system' };
  room.chat.push(entry);
  if (room.chat.length > 100) room.chat.shift();
  broadcast(room, 'chat', { msg: entry }, exceptId);
}

wss.on('connection', (ws) => {
  ws.id = crypto.randomBytes(6).toString('hex');
  ws.roomId = null;

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const room = rooms.get(ws.roomId);
    const me = room && room.clients.get(ws.id);
    const isHost = room && room.hostId === ws.id;

    switch (msg.type) {
      // ---- NTP clock ----
      case 'time:ping': { const t = serverNow(); send(ws, 'time:pong', { t0: msg.t0, t1: t, t2: t }); break; }

      case 'ping:report': {
        if (me) { me.ping = Math.max(0, Math.round(msg.rtt)); notifyPeers(room); }
        break;
      }

      // ---- join ----
      case 'join': {
        const roomId = (msg.roomId || 'main').toLowerCase().trim();
        const role = msg.role === 'host' ? 'host' : 'guest';
        const r = getRoom(roomId);
        ws.roomId = roomId;
        const name = (msg.name || (role === 'host' ? 'Host' : 'Guest')).slice(0, 24);
        r.clients.set(ws.id, { ws, role, name, ping: null, muted: false });
        if (role === 'host') r.hostId = ws.id;
        send(ws, 'joined', { clientId: ws.id, role, roomId, serverTime: serverNow(), isHost: r.hostId === ws.id, ...snapshot(r) });
        notifyPeers(r);
        sysMessage(r, `${name} joined`, ws.id);
        // tell the host a new guest is here so it can offer its stream
        if (role === 'guest' && r.hostId) {
          const host = r.clients.get(r.hostId);
          if (host) send(host.ws, 'guest-ready', { id: ws.id, name });
        }
        break;
      }

      // ---- host: stream title + live flag ----
      case 'title': { if (isHost) { room.title = String(msg.title || '').slice(0, 80); broadcast(room, 'title', { title: room.title }); } break; }
      case 'live':  { if (isHost) { room.live = !!msg.on; broadcast(room, 'live', { on: room.live }); } break; }

      // ---- chat ----
      case 'chat': {
        if (!room || !me || me.muted) return;
        const text = String(msg.text || '').slice(0, 300).trim();
        if (!text) return;
        const entry = { name: me.name, text, ts: serverNow(), role: me.role };
        room.chat.push(entry);
        if (room.chat.length > 100) room.chat.shift();
        broadcast(room, 'chat', { msg: entry });
        break;
      }

      // ---- emoji reactions (ephemeral, not stored) ----
      case 'react': {
        if (!room || !me) return;
        broadcast(room, 'react', { emoji: String(msg.emoji || '🔥').slice(0, 8), name: me.name });
        break;
      }

      // ---- typing indicator (ephemeral) ----
      case 'typing': {
        if (!room || !me) return;
        broadcast(room, 'typing', { name: me.name, on: !!msg.on }, ws.id);
        break;
      }

      // ---- host moderation ----
      case 'mute': {
        if (!isHost) return;
        const t = room.clients.get(msg.id);
        if (t && t.role !== 'host') { t.muted = !!msg.muted; send(t.ws, 'muted', { muted: t.muted }); notifyPeers(room); }
        break;
      }
      case 'kick': {
        if (!isHost) return;
        const t = room.clients.get(msg.id);
        if (t && t.role !== 'host') { send(t.ws, 'kicked', {}); t.ws.close(); }
        break;
      }

      // ---- WebRTC signaling relay (host audio -> guest) ----
      case 'signal': {
        if (!room) return;
        const target = room.clients.get(msg.to);
        if (target) send(target.ws, 'signal', { from: ws.id, data: msg.data });
        break;
      }
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomId);
    if (!room) return;
    const who = room.clients.get(ws.id);
    room.clients.delete(ws.id);
    broadcast(room, 'peer-left', { id: ws.id });
    if (room.hostId === ws.id) { room.hostId = null; room.live = false; broadcast(room, 'host-left', {}); }
    if (room.clients.size === 0) rooms.delete(ws.roomId);
    else { if (who) sysMessage(room, `${who.name} left`); notifyPeers(room); }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ◉  SYNC — live audio`);
  console.log(`    Host (this PC):  http://localhost:${PORT}`);
  for (const iface of Object.values(os.networkInterfaces()))
    for (const n of iface || [])
      if (n.family === 'IPv4' && !n.internal)
        console.log(`    Guests:          http://${n.address}:${PORT}`);
  console.log('');
});
