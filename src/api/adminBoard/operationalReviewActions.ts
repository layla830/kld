import { getMemoryCandidate } from "../../db/memoryCandidates";
import type { Env, MemoryRecord } from "../../types";
import { approveFactTransitionCandidate, rejectFactTransitionCandidate, rollbackFactTransitionCandidate } from "./factTransitionActions";
import { approveMetabolismCandidate, rejectMetabolismCandidate, rollbackMetabolismCandidate } from "./metabolismActions";
import { readFormText } from "./utils";

export interface OperationalReviewResult {
  axis: "Z" | "M";
  action: string;
  memories: MemoryRecord[];
}

async function actionOf(env: Env, form: FormData): Promise<string | null> {
  const id = readFormText(form, "id");
  if (!id) return null;
  return (await getMemoryCandidate(env.DB, "default", id))?.action ?? null;
}

export async function approveOperationalReviewCandidate(env: Env, form: FormData): Promise<OperationalReviewResult | null> {
  const action = await actionOf(env, form);
  if (action === "z_supersede") {
    const result = await approveFactTransitionCandidate(env, form);
    return result ? { ...result, memories: [] } : null;
  }
  const result = await approveMetabolismCandidate(env, form);
  return result ? { axis: "M", action: result.action, memories: result.memory ? [result.memory] : [] } : null;
}

export async function rejectOperationalReviewCandidate(env: Env, form: FormData): Promise<boolean> {
  return await actionOf(env, form) === "z_supersede"
    ? rejectFactTransitionCandidate(env, form)
    : rejectMetabolismCandidate(env, form);
}

export async function rollbackOperationalReviewCandidate(env: Env, form: FormData): Promise<OperationalReviewResult | null> {
  const action = await actionOf(env, form);
  if (action === "z_supersede") {
    const result = await rollbackFactTransitionCandidate(env, form);
    return result ? { ...result, memories: [] } : null;
  }
  const result = await rollbackMetabolismCandidate(env, form);
  return result ? { axis: "M", action: result.action, memories: result.memory ? [result.memory] : [] } : null;
}
