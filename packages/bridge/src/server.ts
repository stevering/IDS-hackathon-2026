import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { ClientInfo, FigmaMessage, ElectronMessage } from './types.js';

type ConnectHandler = (client: ClientInfo) => void;
type MessageHandler = (clientId: string, msg: FigmaMessage) => void;

/**
 * BridgeServer — WebSocket server running in the Electron main process.
 *
 * Figma plugin / widget UIs connect to this server from localhost.
 * The server routes ElectronMessages to specific clients or broadcasts
 * to all, and surfaces FigmaMessages to the Electron app via event handlers.
 */
export class BridgeServer {
  private wss: WebSocketServer | null = null;
  private clients = new Map<string, { ws: WebSocket; info: ClientInfo }>();
  private counter = 0;

  private onConnectHandler?: ConnectHandler;
  private onDisconnectHandler?: ConnectHandler;
  private onMessageHandler?: MessageHandler;

  constructor(private readonly port: number = 3002) {}

  start(): void {
    this.wss = new WebSocketServer({ port: this.port });

    this.wss.on('connection', (ws) => {
      // Assign a temporary ID until we receive the REGISTER message
      const tempId = `pending-${++this.counter}`;

      ws.on('message', (raw: RawData) => {
        try {
          const msg = JSON.parse(raw.toString()) as FigmaMessage;

          if (msg.type === 'REGISTER') {
            // Replace temp entry with a real one
            const info: ClientInfo = {
              id: tempId,
              clientType: msg.clientType,
              widgetId: msg.widgetId,
              fileKey: msg.fileKey,
              connectedAt: Date.now(),
            };
            this.clients.set(tempId, { ws, info });
            // ACK with assigned ID
            ws.send(JSON.stringify({ type: 'REGISTERED', clientId: tempId }));
            this.onConnectHandler?.(info);
            return;
          }

          // Find the client entry by its WebSocket reference
          const entry = [...this.clients.entries()].find(([, v]) => v.ws === ws);
          const clientId = entry?.[0] ?? tempId;
          this.onMessageHandler?.(clientId, msg);
        } catch {
          // ignore malformed JSON
        }
      });

      ws.on('close', () => {
        const entry = [...this.clients.entries()].find(([, v]) => v.ws === ws);
        if (entry) {
          const [id, { info }] = entry;
          this.clients.delete(id);
          this.onDisconnectHandler?.(info);
        }
      });
    });

    console.log(`[guardian/bridge] BridgeServer listening on ws://localhost:${this.port}`);
  }

  stop(): void {
    this.wss?.close();
    this.clients.clear();
  }

  /** Send a message to a specific connected client. */
  send(clientId: string, msg: ElectronMessage): void {
    const entry = this.clients.get(clientId);
    if (entry?.ws.readyState === WebSocket.OPEN) {
      entry.ws.send(JSON.stringify(msg));
    }
  }

  /** Broadcast a message to all connected clients. */
  broadcast(msg: ElectronMessage): void {
    const json = JSON.stringify(msg);
    for (const { ws } of this.clients.values()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(json);
    }
  }

  /** Returns a snapshot of all currently connected clients. */
  getClients(): ClientInfo[] {
    return [...this.clients.values()].map((e) => e.info);
  }

  on(event: 'client-connected', handler: ConnectHandler): this;
  on(event: 'client-disconnected', handler: ConnectHandler): this;
  on(event: 'message', handler: MessageHandler): this;
  on(event: 'client-connected' | 'client-disconnected' | 'message', handler: ConnectHandler | MessageHandler): this {
    if (event === 'client-connected') this.onConnectHandler = handler as ConnectHandler;
    else if (event === 'client-disconnected') this.onDisconnectHandler = handler as ConnectHandler;
    else if (event === 'message') this.onMessageHandler = handler as MessageHandler;
    return this;
  }
}
