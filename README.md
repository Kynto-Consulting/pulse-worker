# Pulse Worker

A minimal WebSocket broker for Cloudflare Workers + Durable Objects.

`pulse-worker` lets you deploy your own real-time WebSocket server on Cloudflare without building a full backend around socket rooms, presence, or connection routing.

It is designed for collaborative apps such as:

- Kanban boards
- Notion-style block editors
- Realtime dashboards
- Presence-aware internal tools
- Lightweight multiplayer or shared cursors

The worker does not persist your app data. Your own backend or database remains the source of truth. `pulse-worker` only handles authenticated WebSocket fan-out, room routing, and optional presence events.

## What it does

- Accepts WebSocket upgrades on `/ws`
- Verifies a signed JWT ticket before opening the socket
- Routes each client to a Durable Object instance per `roomId`
- Broadcasts messages to everyone else in the same room
- Supports optional presence events and presence sync
- Supports optional self-echo behavior per connection
- Exposes `/health` and `/info` endpoints for quick checks

## Architecture

1. Your backend signs a short-lived JWT containing `roomId` and `userId`.
2. The client connects to this worker with that ticket.
3. The worker verifies the token and forwards the request to a Durable Object derived from `roomId`.
4. The Durable Object keeps track of active sockets for that room and broadcasts updates.

This gives you a cheap edge-hosted broker while keeping business rules and persistence in your own backend.

## Endpoints

- `GET /health`
  Returns a simple JSON health payload.

- `GET /info`
  Returns worker capabilities and supported auth modes.

- `GET /ws?token=...`
  Upgrades to WebSocket after token validation.

You can also pass the token with an `Authorization: Bearer <token>` header.

## Token contract

The worker expects a JWT signed with the same secret configured in `PULSE_SECRET`.

Minimum payload:

```json
{
  "roomId": "board-123",
  "userId": "user-42"
}
```

Extended payload supported by the worker:

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

Notes:

- `presence`: if `false`, the worker does not emit join/leave presence events for that connection.
- `presenceSync`: if `true`, the worker sends a `presence.sync` snapshot when the socket connects.
- `selfEcho`: if `true`, the sender also receives its own outgoing message.
- `metadata`: forwarded with presence events.
- `scopes`: currently passed through in the token, ready for future authorization logic.

## Worker events

When a socket connects successfully, the worker emits a ready event:

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

If `presenceSync` is enabled, the worker also emits:

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

Join event:

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

Leave event:

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

If `PULSE_MAX_MESSAGE_BYTES` is configured and a client exceeds it, the worker returns:

```json
{
  "type": "error",
  "code": "MESSAGE_TOO_LARGE",
  "limit": 65536
}
```

## Quick start

### 1. Prerequisites

You need:

- A Cloudflare account
- Node.js 20+
- npm
- Wrangler CLI via local dependency in this project

### 2. Install dependencies

```bash
npm install
```

### 3. Authenticate Wrangler

```bash
npx wrangler login
```

### 4. Configure your secret

The project ships with a dev placeholder in [wrangler.toml](wrangler.toml), but you should override it for real environments.

For local development you can keep the placeholder, but for deployed environments use:

```bash
npx wrangler secret put PULSE_SECRET
```

Optional: if you want to reject large payloads, also set a max size in bytes in [wrangler.toml](wrangler.toml) or through environment config:

```toml
[vars]
PULSE_MAX_MESSAGE_BYTES = "65536"
```

### 5. Run locally

```bash
npm run dev
```

This starts the worker locally, usually on `http://127.0.0.1:8787`.

You can test the non-WebSocket routes immediately:

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/info
```

### 6. Deploy

```bash
npm run deploy
```

Wrangler will deploy the worker and Durable Object migration declared in [wrangler.toml](wrangler.toml).

## Example backend ticket generation

A client should not mint its own token. Your backend should do that.

If you are using `@arubiku/pulse-lib`:

```ts
import { generatePulseTicket } from '@arubiku/pulse-lib';

const token = await generatePulseTicket({
  roomId: 'board-123',
  userId: 'user-42',
  secret: process.env.PULSE_SECRET!,
  features: {
    presence: true,
    presenceSync: true,
    selfEcho: false,
  },
  metadata: {
    name: 'Jane',
    role: 'editor',
  },
  expiresIn: '15m',
});
```

## Example client connection

Vanilla browser WebSocket:

```ts
const ws = new WebSocket(`wss://your-worker.workers.dev/ws?token=${token}`);

ws.onmessage = (event) => {
  console.log(JSON.parse(event.data));
};

ws.onopen = () => {
  ws.send(JSON.stringify({
    type: 'update',
    entity: 'brick',
    id: 'brick-1',
    patch: { title: 'Renamed' },
  }));
};
```

Using `@arubiku/pulse-lib` client:

```ts
import { PulseClient } from '@arubiku/pulse-lib';

const client = new PulseClient('https://your-worker.workers.dev', token, {
  reconnectInterval: 1500,
});

client.on('message', (message) => {
  console.log(message);
});

client.on('presence', (event) => {
  console.log(event);
});

client.connect();
```

## Project files

- [src/index.ts](src/index.ts): request validation, token verification and room routing
- [src/broker.ts](src/broker.ts): Durable Object socket handling and broadcasts
- [src/types.ts](src/types.ts): token and session types
- [wrangler.toml](wrangler.toml): Worker and Durable Object bindings

## Common deployment flow

1. Fork or clone the repo.
2. Change the worker name in [wrangler.toml](wrangler.toml).
3. Set your production `PULSE_SECRET`.
4. Deploy with `npm run deploy`.
5. Generate JWT tickets from your backend.
6. Connect clients to `/ws`.

## Notes for custom servers

This project is intentionally small so you can customize it quickly.

Common extensions teams usually add:

- scope-based authorization before room join
- room membership limits
- rate limiting per user
- schema validation for incoming messages
- custom analytics hooks on connect/disconnect
- write-through persistence to your own API or queue

## Development checks

Typecheck the worker with:

```bash
npm run typecheck
```

## License

Use your preferred license before broader distribution.
