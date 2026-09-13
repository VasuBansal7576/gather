import { GatherGatewayConnection } from "./client.ts";
import { drainDueWork } from "../server/operator-runtime/due-work.ts";
import { runIntakeSweep, type IntakeDeps } from "../server/operator-runtime/intake.ts";

/**
 * Operator bridge under the isolated runtime directory. The runtime owns
 * scheduling: its scheduler calls `runOperatorSweep` on a timer/watch
 * trigger. Gather owns everything business-specific (durable intake,
 * cursors, receipts, decisions). This file translates between the two and
 * owns no business state itself.
 */

export interface OperatorSweepResult {
  intake: Awaited<ReturnType<typeof runIntakeSweep>>;
  dueWork: Awaited<ReturnType<typeof drainDueWork>>;
}

export async function runOperatorSweep(deps: IntakeDeps): Promise<OperatorSweepResult> {
  const intake = await runIntakeSweep(deps);
  const dueWork = await drainDueWork(deps);
  return { intake, dueWork };
}

export interface GatewayHandshakeReport {
  reachable: boolean;
  helloVersion?: string;
  error?: string;
}

/**
 * Actual isolated-Gateway control-plane evidence, reported separately from
 * simulated intake: connects, waits for hello-ok, and disconnects. Never
 * used for business decisions — monitoring signal only.
 */
export async function checkGatewayHandshake(
  connect: () => Promise<{ hello: { version?: string } | null; close: () => Promise<void> }>,
): Promise<GatewayHandshakeReport> {
  try {
    const connection = await connect();
    const version = connection.hello?.version;
    await connection.close();
    return { reachable: true, helloVersion: version };
  } catch (error) {
    return { reachable: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export type { GatherGatewayConnection };
