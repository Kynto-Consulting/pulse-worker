# Pulse Worker

![cloudflare workers](https://img.shields.io/badge/cloudflare-workers-f38020)
![durable objects](https://img.shields.io/badge/state-durable%20objects-1f2937)
![deploy ready](https://img.shields.io/badge/deploy-ready-10b981)

A minimal authenticated WebSocket broker built on Cloudflare Workers and Durable Objects.

`pulse-worker` is meant for teams that want to deploy their own custom WebSocket server quickly without handing over transport to a third-party realtime vendor.

It is a good fit for:

- collaborative boards
- block editors
- live dashboards
- internal tools with presence
- realtime notifications inside an existing product

It is not your database. It is the realtime edge transport layer.

## What you get

- WebSocket upgrade handling on `/ws`
- JWT validation before room join
- routing by `roomId` into a Durable Object
- room-level fan-out broadcasting
- optional presence join/leave events
- optional initial presence snapshot
- optional self-echo behavior
- heartbeat ping/pong support for clients
- health and info endpoints
- lightweight codebase that is easy to fork and customize

## Architecture

1. Your backend signs a short-lived JWT with `roomId` and `userId`.
2. The client connects to `/ws` using that token.
3. The worker validates the token with `PULSE_SECRET`.
4. The worker forwards the request to a Durable Object derived from `roomId`.
5. The Durable Object keeps active sockets for the room and broadcasts updates.

This keeps the source of truth in your own backend while the edge handles fast fan-out.

## Why Pulse instead of Ably?

Pulse exists for teams that want the realtime transport to live inside their own infrastructure instead of inside a managed vendor platform.

Why this can be attractive compared with Ably:

- the worker runs in your own Cloudflare account
- auth is your JWT, your secret, your room model
- the realtime edge endpoint sits on Cloudflare's network, which can reduce latency if the rest of your product is already close to Cloudflare
- you can customize connect rules, broadcasting, rate limits and payload handling in code
- there is no external vendor lock-in around room semantics or message flow

Free-tier economics are also different:

- Ably and similar services usually expose explicit plan limits around connections, channels, history or messages, and those limits can change over time
- Pulse on Cloudflare Workers uses the Cloudflare quota model instead, where the WebSocket handshake is counted as a Worker request
- on Workers Free, the commonly cited quota is around `100k` requests per day, so the relevant ceiling is roughly `100k` new socket handshakes per day for that specific quota category

That is why Pulse is often more attractive for products with many sessions and comparatively light message traffic. It is a different cost model than paying a dedicated realtime SaaS provider for connections and message throughput. Check current pricing pages before quoting exact numbers, because both Cloudflare and Ably can change plan limits.

In short:

- choose Pulse if you want control, edge locality and Cloudflare-native deployment
- choose Ably if you want a more fully managed vendor service and are comfortable with its product limits and pricing model

## Endpoints

### `GET /health`

Returns:

```json
{
  "ok": true,
  "service": "pulse-worker"
}
```

### `GET /info`

Returns worker capabilities and auth modes.

### `GET /ws?token=...`

Performs WebSocket upgrade after JWT validation.

Also supported:

```http
Authorization: Bearer <token>
```

## Token contract

Minimum payload:

```json
{
  "roomId": "board-123",
  "userId": "user-42"
}
```

Extended payload:

```json
{
  "roomId": "board-123",
  "userId": "user-42",
  "features": {
    "presence": true,
    "presenceSync": true,
    "selfEcho": false
  },
  "metadata": {
    "name": "Jane",
    "role": "editor"
  },
  "scopes": ["read", "write"]
}
```

Current behavior:

- `presence: false`
  No join/leave events for that connection.

- `presenceSync: true`
  Sends a room presence snapshot immediately after connect.

- `selfEcho: true`
  Broadcasts messages back to the sender too.

- `metadata`
  Included in presence payloads.

- `scopes`
  Accepted in the token and available for future auth extensions.

## Worker events

### Ready event

```json
{
  "type": "system",
  "event": "ready",
  "roomId": "board-123",
  "userId": "user-42",
  "features": {
    "presence": true,
    "presenceSync": true,
    "selfEcho": false
  }
}
```

### Heartbeat pong

If the client sends the internal heartbeat message:

```json
{
  "type": "pulse",
  "event": "ping"
}
```

the worker answers only to that socket with:

```json
{
  "type": "system",
  "event": "pong",
  "ts": 1712188800000
}
```

This helps clients detect dead sockets without broadcasting heartbeat traffic to the rest of the room.

### Presence sync

```json
{
  "type": "presence",
  "event": "sync",
  "users": [
    {
      "userId": "user-42",
      "metadata": {
        "name": "Jane"
      }
    }
  ]
}
```

### Presence join

```json
{
  "type": "presence",
  "event": "join",
  "userId": "user-42",
  "metadata": {
    "name": "Jane"
  }
}
```

### Presence leave

```json
{
  "type": "presence",
  "event": "leave",
  "userId": "user-42",
  "metadata": {
    "name": "Jane"
  }
}
```

### Message too large

If `PULSE_MAX_MESSAGE_BYTES` is configured and the client exceeds it:

```json
{
  "type": "error",
  "code": "MESSAGE_TOO_LARGE",
  "limit": 65536
}
```

## Quick start

### 1. Clone and install

```bash
npm install
```

### 2. Login to Cloudflare

```bash
npx wrangler login
```

### 3. Configure the worker name

Edit [wrangler.toml](wrangler.toml):

```toml
name = "your-pulse-worker"
```

### 4. Configure the shared secret

For real deployments, set it as a Wrangler secret:

```bash
npx wrangler secret put PULSE_SECRET
```

### 5. Run locally

```bash
npm run dev
```

Usually available at:

```text
http://127.0.0.1:8787
```

### 6. Smoke check the HTTP routes

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/info
```

### 7. Deploy

```bash
npm run deploy
```

## Environment setup

### Local dev

You can keep the placeholder `PULSE_SECRET` in [wrangler.toml](wrangler.toml) only for local development.

Optional variable:

```toml
[vars]
PULSE_MAX_MESSAGE_BYTES = "65536"
```

### Staging

Recommended staging shape:

- different worker name
- different `PULSE_SECRET`
- optional stricter `PULSE_MAX_MESSAGE_BYTES`
- separate frontend config pointing at staging URL

Example approach:

```toml
[env.staging]
name = "pulse-worker-staging"
```

Then set secrets for that environment with Wrangler.

### Production

Recommended production shape:

- production-only `PULSE_SECRET`
- custom domain or workers.dev URL pinned in your app config
- observability through your own logs/analytics hooks
- explicit size limits if your client payloads can grow unexpectedly

## Example backend ticket generation

Use `@arubiku/pulse-lib` on your backend:

```ts
import { generatePulseTicket } from '@arubiku/pulse-lib';

const token = await generatePulseTicket({
  roomId: 'board-123',
  userId: 'user-42',
  secret: process.env.PULSE_SECRET!,
  expiresIn: '15m',
  features: {
    presence: true,
    presenceSync: true,
    selfEcho: false,
  },
  metadata: {
    name: 'Jane',
    role: 'editor',
  },
});
```

## Example clients

### Native browser WebSocket

```ts
const ws = new WebSocket(`wss://your-worker.workers.dev/ws?token=${token}`);

ws.onmessage = (event) => {
  console.log(JSON.parse(event.data));
};
```

### With `@arubiku/pulse-lib`

```ts
import { PulseClient } from '@arubiku/pulse-lib';

const client = new PulseClient('https://your-worker.workers.dev', token, {
  reconnectInterval: 1500,
});

client.on('presence', (event) => console.log(event));
client.on('message', (event) => console.log(event));
client.connect();
```

## Customization ideas

This repo is intentionally small so teams can fork and adapt it fast.

Common customizations:

- schema validation before broadcast
- scope-based room authorization
- write permissions vs read-only sockets
- room occupancy limits
- per-user rate limiting
- analytics hooks on connect and disconnect
- forwarding writes to your own API or queue
- server-side event enrichment before fan-out

## Project files

- [src/index.ts](src/index.ts)
  Token verification, request routing and HTTP endpoints.

- [src/broker.ts](src/broker.ts)
  Durable Object connection lifecycle and room broadcasting.

- [src/types.ts](src/types.ts)
  Shared token and session types.

- [wrangler.toml](wrangler.toml)
  Worker config, bindings and migration declarations.

## Troubleshooting

### `Invalid ticket`

The signing secret in your backend does not match `PULSE_SECRET` in the worker.

### `Expected Upgrade: websocket`

You are calling `/ws` as plain HTTP instead of opening a WebSocket.

### Clients connect but do not see each other

Check that they are using the same `roomId` inside the signed JWT.

### Presence is missing

Set `features.presence` and `features.presenceSync` in the token.

### Sender does not receive its own message

This is the default behavior. Enable `features.selfEcho = true` if you want message echo.

### Payload rejected as too large

Increase `PULSE_MAX_MESSAGE_BYTES` or send smaller deltas instead of large documents.

### Local dev works but prod fails

Check these first:

- worker URL mismatch
- wrong production secret
- frontend still pointing to localhost
- environment-specific Wrangler secret not configured

## Development checks

```bash
npm run typecheck
```

## Deploy checklist

1. rename the worker in [wrangler.toml](wrangler.toml)
2. set `PULSE_SECRET`
3. optionally set `PULSE_MAX_MESSAGE_BYTES`
4. deploy with `npm run deploy`
5. generate tickets from your backend
6. connect clients to `/ws`

## License

[MIT](LICENSE)
