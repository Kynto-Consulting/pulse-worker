import { DurableObject } from 'cloudflare:workers';
import { Env } from './index';
import { PresenceMember, SessionData } from './types';

export class PulseBroker extends DurableObject {
  env: Env;
  sessions: Map<WebSocket, SessionData>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.env = env;
    this.sessions = new Map();

    for (const socket of this.ctx.getWebSockets()) {
      const session = socket.deserializeAttachment() as SessionData | null;
      if (session) {
        this.sessions.set(socket, session);
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    const roomId = request.headers.get('X-Pulse-Room-Id') || 'unknown';
    const userId = request.headers.get('X-Pulse-User-Id') || 'unknown';
    const features = this.parseJsonHeader(request.headers.get('X-Pulse-Features'));
    const metadata = this.parseJsonHeader(request.headers.get('X-Pulse-Metadata'));
    const session: SessionData = {
      roomId,
      userId,
      features,
      metadata,
    };
    
    // Accept WebSocket and associate it with our Durable Object state
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(session);
    this.sessions.set(server, session);

    server.send(JSON.stringify({
      type: 'system',
      event: 'ready',
      roomId,
      userId,
      features,
    }));

    if (features.presenceSync) {
      server.send(JSON.stringify({
        type: 'presence',
        event: 'sync',
        users: this.getPresenceMembers(),
      }));
    }

    // Broadcast presence (join) to everyone currently connected
    if (features.presence !== false) {
      this.broadcast(server, JSON.stringify({
        type: 'presence',
        event: 'join',
        userId,
        metadata,
      }));
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  // Called when a message is received from a WebSocket
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const session = this.sessions.get(ws);
    const maxMessageBytes = Number(this.env.PULSE_MAX_MESSAGE_BYTES || '0');

    if (maxMessageBytes > 0 && this.getMessageSize(message) > maxMessageBytes) {
      ws.send(JSON.stringify({
        type: 'error',
        code: 'MESSAGE_TOO_LARGE',
        limit: maxMessageBytes,
      }));
      return;
    }

    // Pure pass-through: We act as a blind reflector (lowest latency)
    this.broadcast(ws, message, session?.features.selfEcho === true);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    this.handleLeave(ws);
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    this.handleLeave(ws);
  }

  private handleLeave(ws: WebSocket) {
    const session = this.sessions.get(ws);
    if (session) {
      if (session.features.presence !== false) {
        this.broadcast(ws, JSON.stringify({
          type: 'presence',
          event: 'leave',
          userId: session.userId,
          metadata: session.metadata,
        }));
      }
      this.sessions.delete(ws);
    }
  }

  // Broadcast to all active websockets except the sender
  private broadcast(sender: WebSocket, message: string | ArrayBuffer, includeSender = false) {
    const activeSockets = this.ctx.getWebSockets();
    for (const ws of activeSockets) {
      if (includeSender || ws !== sender) {
        try {
          ws.send(message);
        } catch (e) {
          // Ignore errors from disconnected clients in transit
        }
      }
    }
  }

  private getPresenceMembers(): PresenceMember[] {
    return Array.from(this.sessions.values()).map((session) => ({
      userId: session.userId,
      metadata: session.metadata,
    }));
  }

  private getMessageSize(message: string | ArrayBuffer): number {
    if (typeof message === 'string') {
      return new TextEncoder().encode(message).byteLength;
    }

    return message.byteLength;
  }

  private parseJsonHeader(raw: string | null): Record<string, unknown> {
    if (!raw) {
      return {};
    }

    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}
