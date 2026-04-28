import type { Env, QueueMessage } from "../types";
import { runMemoryMaintenance } from "../memory/maintenance";

export async function handleQueueMessage(message: QueueMessage, env: Env): Promise<void> {
  switch (message.type) {
    case "memory_maintenance":
      await runMemoryMaintenance(env, message);
      return;
  }
}
