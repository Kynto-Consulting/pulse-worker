/**
 * End-to-end test for websockets.kynto.workers.dev
 * Usage: node test-ws.mjs <PULSE_SECRET> <PULSE_BROADCAST_SECRET>
 */
import { SignJWT } from 'jose';

const BASE_URL = 'https://websockets.kynto.workers.dev';
const WS_URL   = BASE_URL.replace('https', 'wss');

const [,, PULSE_SECRET, BROADCAST_SECRET] = process.argv;
if (!PULSE_SECRET || !BROADCAST_SECRET) {
  console.error('Usage: node test-ws.mjs <PULSE_SECRET> <PULSE_BROADCAST_SECRET>');
  process.exit(1);
}

let passed = 0, failed = 0;
function ok(label)   { console.log(`  ✓ ${label}`); passed++; }
function fail(label, detail) { console.error(`  ✗ ${label}: ${detail}`); failed++; }

async function signToken(roomId, userId, features = {}) {
  const secret = new TextEncoder().encode(PULSE_SECRET);
  return new SignJWT({ roomId, userId, features })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(secret);
}

// ── HTTP tests ────────────────────────────────────────────────────────────────

console.log('\n[1] HTTP endpoints');

// GET /health
{
  const r = await fetch(`${BASE_URL}/health`);
  const b = await r.json();
  r.ok && b.ok ? ok('GET /health → 200 ok:true') : fail('GET /health', JSON.stringify(b));
}

// GET /info
{
  const r = await fetch(`${BASE_URL}/info`);
  const b = await r.json();
  r.ok && b.features ? ok('GET /info → 200 with features[]') : fail('GET /info', JSON.stringify(b));
}

// POST /broadcast — no auth
{
  const r = await fetch(`${BASE_URL}/broadcast`, { method: 'POST' });
  r.status === 401 ? ok('POST /broadcast (no auth) → 401') : fail('POST /broadcast no auth', `got ${r.status}`);
}

// POST /broadcast — wrong secret
{
  const r = await fetch(`${BASE_URL}/broadcast`, {
    method: 'POST',
    headers: { Authorization: 'Bearer wrong-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomId: 'test:1', event: 'x', payload: {} }),
  });
  r.status === 401 ? ok('POST /broadcast (wrong secret) → 401') : fail('POST /broadcast wrong secret', `got ${r.status}`);
}

// POST /broadcast — missing roomId
{
  const r = await fetch(`${BASE_URL}/broadcast`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${BROADCAST_SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'x', payload: {} }),
  });
  r.status === 400 ? ok('POST /broadcast (missing roomId) → 400') : fail('POST /broadcast missing roomId', `got ${r.status}`);
}

// ── WebSocket tests ───────────────────────────────────────────────────────────

console.log('\n[2] WebSocket connection');

// WS without token
{
  const ws = new WebSocket(`${WS_URL}/ws`);
  await new Promise(resolve => {
    ws.onclose  = e => { e.code !== 1006 ? ok(`WS no token → closed ${e.code}`) : ok('WS no token → refused (1006)'); resolve(); };
    ws.onerror  = () => { ok('WS no token → rejected (error)'); resolve(); };
    ws.onopen   = () => { fail('WS no token', 'connected without token'); ws.close(); resolve(); };
    setTimeout(() => { ws.close(); resolve(); }, 4000);
  });
}

// WS with valid token + receive ready event
{
  const token = await signToken('test:room1', 'user-A', { presenceSync: true });
  const ws = new WebSocket(`${WS_URL}/ws?token=${encodeURIComponent(token)}`);
  const received = [];

  await new Promise(resolve => {
    ws.onmessage = e => { received.push(JSON.parse(e.data)); };
    ws.onopen    = () => {};
    ws.onclose   = () => resolve();
    setTimeout(() => { ws.close(); resolve(); }, 3000);
  });

  const ready = received.find(m => m.type === 'system' && m.event === 'ready');
  ready ? ok(`WS connect → got system:ready (roomId=${ready.roomId})`) : fail('WS connect', `no ready event, got: ${JSON.stringify(received)}`);
}

// WS broadcast: client A connects, server broadcasts, A receives
{
  const roomId = `test:broadcast-${Date.now()}`;
  const tokenA = await signToken(roomId, 'user-A');
  const wsA    = new WebSocket(`${WS_URL}/ws?token=${encodeURIComponent(tokenA)}`);
  const receivedByA = [];

  await new Promise(r => { wsA.onopen = r; setTimeout(r, 3000); });

  wsA.onmessage = e => receivedByA.push(JSON.parse(e.data));

  // POST broadcast to room
  const broadcastRes = await fetch(`${BASE_URL}/broadcast`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${BROADCAST_SECRET}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ roomId, event: 'test.ping', payload: { hello: 'world' } }),
  });

  broadcastRes.ok ? ok('POST /broadcast (valid) → 200') : fail('POST /broadcast valid', `got ${broadcastRes.status}`);

  await new Promise(r => setTimeout(r, 1500));
  wsA.close();
  await new Promise(r => setTimeout(r, 500));

  const msg = receivedByA.find(m => m.event === 'test.ping');
  msg && msg.payload?.hello === 'world'
    ? ok(`WS received broadcast → event=${msg.event} payload=${JSON.stringify(msg.payload)}`)
    : fail('WS receive broadcast', `got: ${JSON.stringify(receivedByA)}`);
}

// WS peer-to-peer: A and B in same room, B sends, A receives
{
  const roomId = `test:p2p-${Date.now()}`;
  const [tokA, tokB] = await Promise.all([signToken(roomId, 'user-A'), signToken(roomId, 'user-B')]);
  const [wsA, wsB]   = [new WebSocket(`${WS_URL}/ws?token=${encodeURIComponent(tokA)}`), new WebSocket(`${WS_URL}/ws?token=${encodeURIComponent(tokB)}`)];
  const receivedByA  = [];

  await Promise.all([
    new Promise(r => { wsA.onopen = r; setTimeout(r, 3000); }),
    new Promise(r => { wsB.onopen = r; setTimeout(r, 3000); }),
  ]);

  wsA.onmessage = e => receivedByA.push(JSON.parse(e.data));
  await new Promise(r => setTimeout(r, 300));

  wsB.send(JSON.stringify({ event: 'chat.msg', payload: { text: 'hi from B' } }));
  await new Promise(r => setTimeout(r, 1500));

  wsA.close(); wsB.close();
  await new Promise(r => setTimeout(r, 500));

  const msg = receivedByA.find(m => m.event === 'chat.msg');
  msg && msg.payload?.text === 'hi from B'
    ? ok(`WS peer→peer → A received B's message: "${msg.payload.text}"`)
    : fail('WS peer→peer', `A got: ${JSON.stringify(receivedByA)}`);
}

// ── Presence test ─────────────────────────────────────────────────────────────

console.log('\n[3] Presence');

{
  const roomId = `test:presence-${Date.now()}`;
  const [tokA, tokB] = await Promise.all([
    signToken(roomId, 'user-A', { presence: true, presenceSync: true }),
    signToken(roomId, 'user-B', { presence: true }),
  ]);
  const wsA = new WebSocket(`${WS_URL}/ws?token=${encodeURIComponent(tokA)}`);
  const presenceEventsOnA = [];

  await new Promise(r => { wsA.onopen = r; setTimeout(r, 3000); });
  wsA.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type === 'presence') presenceEventsOnA.push(m);
  };

  await new Promise(r => setTimeout(r, 300));
  const wsB = new WebSocket(`${WS_URL}/ws?token=${encodeURIComponent(tokB)}`);
  await new Promise(r => { wsB.onopen = r; setTimeout(r, 3000); });
  await new Promise(r => setTimeout(r, 1000));

  wsA.close(); wsB.close();
  await new Promise(r => setTimeout(r, 500));

  const joinEvent = presenceEventsOnA.find(e => e.event === 'join' && e.userId === 'user-B');
  joinEvent
    ? ok(`Presence join → A received user-B joined`)
    : fail('Presence join', `A presence events: ${JSON.stringify(presenceEventsOnA)}`);
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
