import { createMemory, softDeleteMemory, updateMemory } from "../../db/memories";
import type { Env, MemoryRecord } from "../../types";
import { clampNumber, parseTagInput, readFormText } from "./utils";

export async function createBoardMemory(env: Env, form: FormData): Promise<MemoryRecord | null> {
  const kind = readFormText(form, "kind");
  const content = readFormText(form, "content");
  if (!content) return null;

  let type = "note";
  let tags = ["admin-board"];
  let pinned = false;

  if (kind === "message") {
    type = "message";
    tags = ["留言", "unread", "admin-board"];
  } else if (kind === "diary") {
    const author = readFormText(form, "author") || "layla";
    type = author === "kld" ? "diary" : "layla_diary";
    tags = ["日记", author, "admin-board"];
  } else if (kind === "quote") {
    const category = readFormText(form, "category") || "语录";
    tags = ["语录", category, "admin-board"];
  } else if (kind === "memory") {
    type = readFormText(form, "memory_type") || "note";
    tags = parseTagInput(readFormText(form, "tags"));
    tags.push("admin-board");
    pinned = readFormText(form, "pinned") === "on";
  }

  const mood = readFormText(form, "mood");
  if (mood) tags.push(`mood:${mood}`);

  return createMemory(env.DB, {
    namespace: "default",
    type,
    content,
    summary: null,
    importance: pinned ? 1 : 0.65,
    confidence: 0.95,
    status: "active",
    pinned,
    tags: [...new Set(tags)],
    source: "admin-board",
    sourceMessageIds: [],
    expiresAt: null
  });
}

export async function editBoardMemory(env: Env, form: FormData): Promise<MemoryRecord | null> {
  const id = readFormText(form, "id");
  const content = readFormText(form, "content");
  if (!id || !content) return null;

  const type = readFormText(form, "type") || "note";
  const tags = parseTagInput(readFormText(form, "tags"));
  const mood = readFormText(form, "mood");
  if (mood) tags.push(`mood:${mood}`);
  if (type === "message" && !tags.includes("留言")) tags.push("留言");

  return updateMemory(env.DB, {
    namespace: "default",
    id,
    patch: {
      type,
      content,
      tags: [...new Set(tags)],
      importance: clampNumber(readFormText(form, "importance"), 0.65, 0, 1),
      pinned: readFormText(form, "pinned") === "on"
    }
  });
}

export async function deleteBoardMemory(env: Env, form: FormData): Promise<MemoryRecord | null> {
  const id = readFormText(form, "id");
  if (!id) return null;
  return softDeleteMemory(env.DB, { namespace: "default", id });
}
