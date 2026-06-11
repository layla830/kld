import type { Env, MemoryRecord } from "../types";
import { callOpenAICompatEmbeddings } from "../proxy/openaiAdapter";

const DEFAULT_EMBEDDING_MODEL = "workers-ai/@cf/google/embeddinggemma-300m";
const MAX_METADATA_CONTENT_CHARS = 1_000;
const MAX_METADATA_SUMMARY_CHARS = 500;

function workersAiModelName(model: string): string | null {
  const normalized = model.trim();
  if (normalized.startsWith("workers-ai/")) return normalized.slice("workers-ai/".length);
  if (normalized.startsWith("@cf/")) return normalized;
  return null;
}

function readEmbedding(result: unknown): number[] | null {
  if (!result || typeof result !== "object") return null;
  const value = result as {
    data?: unknown;
    embedding?: unknown;
    embeddings?: unknown;
  };

  if (Array.isArray(value.embedding) && typeof value.embedding[0] === "number") {
    return value.embedding as number[];
  }

  if (Array.isArray(value.embeddings) && Array.isArray(value.embeddings[0])) {
    return value.embeddings[0] as number[];
  }

  if (Array.isArray(value.data)) {
    const first = value.data[0] as { embedding?: unknown } | number[] | undefined;
    if (first && typeof first === "object" && !Array.isArray(first) && Array.isArray(first.embedding)) {
      return first.embedding as number[];
    }
    if (Array.isArray(first)) return first as number[];
    if (typeof value.data[0] === "number") return value.data as number[];
  }

  return null;
}

function truncateMetadata(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value;
}

export async function createEmbedding(env: Env, text: string): Promise<number[] | null> {
  const model = env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
  const workersAiModel = workersAiModelName(model);
  if (workersAiModel) {
    if (!env.AI) return null;
    try {
      const result = await env.AI.run(workersAiModel as any, { text: [text] });
      return readEmbedding(result);
    } catch (error) {
      console.error("memory embedding failed", error);
      return null;
    }
  }

  let response: Response;
  try {
    response = await callOpenAICompatEmbeddings(env, {
      model,
      input: text
    });
  } catch (error) {
    console.error("memory embedding failed", error);
    return null;
  }

  if (!response.ok) return null;
  return readEmbedding(await response.json());
}

export async function upsertMemoryEmbedding(env: Env, memory: MemoryRecord): Promise<boolean> {
  if (!env.VECTORIZE || memory.status !== "active") return false;

  const vector = await createEmbedding(env, memory.content);
  if (!vector || !memory.vector_id) return false;

  await env.VECTORIZE.upsert([
    {
      id: memory.vector_id,
      values: vector,
      metadata: {
        namespace: memory.namespace,
        kind: "memory",
        ref_id: memory.id,
        type: memory.type,
        content: truncateMetadata(memory.content, MAX_METADATA_CONTENT_CHARS),
        summary: truncateMetadata(memory.summary || "", MAX_METADATA_SUMMARY_CHARS),
        importance: memory.importance,
        confidence: memory.confidence,
        status: memory.status,
        pinned: Boolean(memory.pinned),
        tags: memory.tags || "[]",
        source: memory.source || "",
        source_message_ids: memory.source_message_ids || "[]",
        created_at: memory.created_at,
        updated_at: memory.updated_at,
        expires_at: memory.expires_at || "",
      }
    }
  ]);

  try {
    await env.DB.prepare("UPDATE memories SET vector_synced = 1 WHERE id = ?").bind(memory.id).run();
  } catch (error) {
    console.error("memory vector_synced flag update failed", memory.id, error);
  }

  return true;
}

export async function deleteMemoryEmbedding(env: Env, memory: MemoryRecord): Promise<boolean> {
  if (!env.VECTORIZE || !memory.vector_id) return false;
  await env.VECTORIZE.deleteByIds([memory.vector_id]);
  return true;
}
