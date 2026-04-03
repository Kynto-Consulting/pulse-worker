import { jwtVerify } from 'jose';
import { PulseTokenPayload } from './types';

// Export the Durable Object class so Cloudflare can bind to it
export { PulseBroker } from './broker';

export interface Env {
  PULSE_SECRET: string;
  PULSE_DO: DurableObjectNamespace;
  PULSE_MAX_MESSAGE_BYTES?: string;
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init?.headers ?? {}),
    },
  });
}

function getToken(request: Request, url: URL): string | null {
  const queryToken = url.searchParams.get('token');
  if (queryToken) {
    return queryToken;
  }

  const authHeader = request.headers.get('Authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length);
  }

  return null;
}

function isPulseTokenPayload(value: unknown): value is PulseTokenPayload {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const payload = value as Record<string, unknown>;
  return typeof payload.roomId === 'string' && typeof payload.userId === 'string';
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({ ok: true, service: 'pulse-worker' });
    }

    if (request.method === 'GET' && url.pathname === '/info') {
      return json({
        service: 'pulse-worker',
        auth: ['query-token', 'bearer-token'],
        features: ['presence', 'presenceSync', 'selfEcho', 'maxMessageBytes'],
      });
    }
    
    if (url.pathname !== '/ws') {
      return new Response('Not found', { status: 404 });
    }

    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected Upgrade: websocket', { status: 426 });
    }

    const token = getToken(request, url);
    if (!token) {
      return new Response('Missing ticket (JWT token)', { status: 401 });
    }

    let payload: PulseTokenPayload;
    try {
      const secret = new TextEncoder().encode(env.PULSE_SECRET);
      const result = await jwtVerify(token, secret);
      if (!isPulseTokenPayload(result.payload)) {
        return new Response('Invalid ticket payload. Missing roomId or userId.', { status: 401 });
      }

      payload = result.payload;
    } catch (e) {
      return new Response('Invalid ticket', { status: 401 });
    }

    const roomId = payload.roomId;
    const userId = payload.userId;

    // Delegate to the correct Durable Object instance based on roomId
    const id = env.PULSE_DO.idFromName(roomId);
    const stub = env.PULSE_DO.get(id);

    // Reconstruct the request to pass over the verified userId
    const forwardedHeaders = new Headers(request.headers);
    forwardedHeaders.set('X-Pulse-Room-Id', roomId);
    forwardedHeaders.set('X-Pulse-User-Id', userId);
    forwardedHeaders.set('X-Pulse-Features', JSON.stringify(payload.features ?? {}));
    forwardedHeaders.set('X-Pulse-Metadata', JSON.stringify(payload.metadata ?? {}));

    if (env.PULSE_MAX_MESSAGE_BYTES) {
      forwardedHeaders.set('X-Pulse-Max-Message-Bytes', env.PULSE_MAX_MESSAGE_BYTES);
    }

    const newRequest = new Request(request, {
      headers: forwardedHeaders,
    });

    return stub.fetch(newRequest);
  },
};
