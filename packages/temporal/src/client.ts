/**
 * Temporal client factory.
 *
 * Creates a singleton Temporal client for use by API routes.
 * The client connects to the Temporal server to start/signal/query workflows.
 *
 * Supports three connection modes (auto-detected from env vars):
 *   1. Local dev server — plain gRPC, no TLS (default)
 *   2. Temporal Cloud API key — TLS + TEMPORAL_API_KEY
 *   3. Temporal Cloud mTLS — TLS + base64-encoded client certificate pair
 */

import { Client, Connection, type ConnectionOptions } from "@temporalio/client";

let clientInstance: Client | null = null;
let connectionPromise: Promise<Client> | null = null;

export async function getTemporalClient(): Promise<Client> {
  if (clientInstance) return clientInstance;

  // Prevent multiple concurrent connection attempts
  if (!connectionPromise) {
    connectionPromise = createClient();
  }

  return connectionPromise;
}

async function createClient(): Promise<Client> {
  const address = process.env.TEMPORAL_ADDRESS ?? "localhost:7233";
  const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
  const apiKey = process.env.TEMPORAL_API_KEY;
  const certB64 = process.env.TEMPORAL_CLIENT_CERT_BASE64;
  const keyB64 = process.env.TEMPORAL_CLIENT_KEY_BASE64;

  const connOpts: ConnectionOptions = { address };

  if (apiKey) {
    // Temporal Cloud — API key authentication
    connOpts.tls = true;
    connOpts.apiKey = apiKey;
  } else if (certB64 && keyB64) {
    // Temporal Cloud — mTLS certificate authentication
    connOpts.tls = {
      clientCertPair: {
        crt: Buffer.from(certB64, "base64"),
        key: Buffer.from(keyB64, "base64"),
      },
    };
  }

  const connection = await Connection.connect(connOpts);

  clientInstance = new Client({
    connection,
    namespace,
  });

  return clientInstance;
}

/**
 * Get the Temporal task queue name from environment.
 */
export function getTaskQueue(): string {
  return process.env.TEMPORAL_TASK_QUEUE ?? "guardian-orchestration";
}
