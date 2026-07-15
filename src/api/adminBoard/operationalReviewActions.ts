import { getMemoryCandidate } from "../../db/memoryCandidates";
import type { Env, MemoryRecord } from "../../types";
import { approveFactTransitionCandidate, rejectFactTransitionCandidate, rollbackFactTransitionCandidate } from "./factTransitionActions";
import { approveMetabolismCandidate, rejectMetabolismCandidate, rollbackMetabolismCandidate } from "./metabolismActions";
import { approveRelationReviewCandidate, rejectRelationReviewCandidate, rollbackRelationReviewCandidate } from "./relationReviewActions";
import { loadDreamConfig } from "../../config/runtime";
import { readFormText } from "./utils";

export interface OperationalReviewResult {
  axis: "Y" | "Z" | "M";
  action: string;
  memories: MemoryRecord[];
}

async function actionOf(env: Env, form: FormData): Promise<string | null> {
  const id = readFormText(form, "id");
  if (!id) return null;
  return (await getMemoryCandidate(env.DB, loadDreamConfig(env).namespace, id))?.action ?? null;
}

export async function approveOperationalReviewCandidate(env: Env, form: FormData): Promise<OperationalReviewResult | null> {
  const action = await actionOf(env, form);
  if (action === "z_supersede") {
    const result = await approveFactTransitionCandidate(env, form);
    return result ? { ...result, memories: [] } : null;
  }
  if (action === "y_relation_review") {
    const result = await approveRelationReviewCandidate(env, form);
    return result ? { axis: "Y", action: result.action, memories: [] } : null;
  }
  const result = await approveMetabolismCandidate(env, form);
  return result ? { axis: "M", action: result.action, memories: result.memory ? [result.memory] : [] } : null;
}

export async function rejectOperationalReviewCandidate(env: Env, form: FormData): Promise<boolean> {
  const action = await actionOf(env, form);
  if (action === "z_supersede") return rejectFactTransitionCandidate(env, form);
  if (action === "y_relation_review") return rejectRelationReviewCandidate(env, form);
  return rejectMetabolismCandidate(env, form);
}

export async function rollbackOperationalReviewCandidate(env: Env, form: FormData): Promise<OperationalReviewResult | null> {
  const action = await actionOf(env, form);
  if (action === "z_supersede") {
    const result = await rollbackFactTransitionCandidate(env, form);
    return result ? { ...result, memories: [] } : null;
  }
  if (action === "y_relation_review") {
    const result = await rollbackRelationReviewCandidate(env, form);
    return result ? { axis: "Y", action: result.action, memories: [] } : null;
  }
  const result = await rollbackMetabolismCandidate(env, form);
  return result ? { axis: "M", action: result.action, memories: result.memory ? [result.memory] : [] } : null;
}
