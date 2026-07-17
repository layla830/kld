import { getMemoryCandidate } from "../../db/memoryCandidates";
import type { Env, MemoryRecord } from "../../types";
import { approveFactTransitionCandidate, rejectFactTransitionCandidate, rollbackFactTransitionCandidate } from "./factTransitionActions";
import {
  approveMetabolismCandidate,
  rejectMetabolismCandidate,
  rollbackMetabolismCandidate,
  type MetabolismAction
} from "./metabolismActions";
import { approveRelationReviewCandidate, rejectRelationReviewCandidate, rollbackRelationReviewCandidate } from "./relationReviewActions";
import { loadDreamConfig } from "../../config/runtime";
import { readFormText } from "./utils";

export interface OperationalReviewResult {
  axis: "Y" | "Z" | "M";
  action: string;
  memories: MemoryRecord[];
}

export type OperationalCandidateAction = "z_supersede" | "y_relation_review" | MetabolismAction;

export function parseOperationalCandidateAction(value: string | null | undefined): OperationalCandidateAction | null {
  switch (value) {
    case "z_supersede":
    case "y_relation_review":
    case "m_archive":
    case "m_relation_cleanup":
      return value;
    default:
      return null;
  }
}

async function actionOf(env: Env, form: FormData): Promise<OperationalCandidateAction | null> {
  const id = readFormText(form, "id");
  if (!id) return null;
  return parseOperationalCandidateAction(
    (await getMemoryCandidate(env.DB, loadDreamConfig(env).namespace, id))?.action
  );
}

export async function approveOperationalReviewCandidate(env: Env, form: FormData): Promise<OperationalReviewResult | null> {
  const action = await actionOf(env, form);
  switch (action) {
    case "z_supersede": {
      const result = await approveFactTransitionCandidate(env, form);
      return result ? { ...result, memories: [] } : null;
    }
    case "y_relation_review": {
      const result = await approveRelationReviewCandidate(env, form);
      return result ? { axis: "Y", action: result.action, memories: [] } : null;
    }
    case "m_archive":
    case "m_relation_cleanup": {
      const result = await approveMetabolismCandidate(env, form);
      return result ? { axis: "M", action: result.action, memories: result.memory ? [result.memory] : [] } : null;
    }
    case null:
      return null;
  }
}

export async function rejectOperationalReviewCandidate(env: Env, form: FormData): Promise<boolean> {
  const action = await actionOf(env, form);
  switch (action) {
    case "z_supersede":
      return rejectFactTransitionCandidate(env, form);
    case "y_relation_review":
      return rejectRelationReviewCandidate(env, form);
    case "m_archive":
    case "m_relation_cleanup":
      return rejectMetabolismCandidate(env, form);
    case null:
      return false;
  }
}

export async function rollbackOperationalReviewCandidate(env: Env, form: FormData): Promise<OperationalReviewResult | null> {
  const action = await actionOf(env, form);
  switch (action) {
    case "z_supersede": {
      const result = await rollbackFactTransitionCandidate(env, form);
      return result ? { ...result, memories: [] } : null;
    }
    case "y_relation_review": {
      const result = await rollbackRelationReviewCandidate(env, form);
      return result ? { axis: "Y", action: result.action, memories: [] } : null;
    }
    case "m_archive":
    case "m_relation_cleanup": {
      const result = await rollbackMetabolismCandidate(env, form);
      return result ? { axis: "M", action: result.action, memories: result.memory ? [result.memory] : [] } : null;
    }
    case null:
      return null;
  }
}
