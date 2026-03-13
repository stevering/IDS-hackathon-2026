/**
 * Temporal client factory.
 *
 * Creates a singleton Temporal client for use by API routes.
 * The client connects to the Temporal server to start/signal/query workflows.
 */

import { Client, Connection } from "@temporalio/client";

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

  const connection = await Connection.connect({ address });

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
