/**
 * Pure conversion: AssembledPrompt -> Anthropic wire format types.
 *
 * These helpers do NOT call any adapter, DB, or external service. The chat
 * adapter uses them to build the upstream Anthropic native request body.
 *
 * Determinism: given the same AssembledPrompt, output is bit-for-bit identical.
 */

import type { AssembledPrompt, SystemBlock } from "./types";

// ---------------------------------------------------------------------------
// Anthropic wire types (subset needed for system + messages)
// ---------------------------------------------------------------------------

export interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: {
    type: "ephemeral";
    ttl?: "5m" | "1h";
  };
}

export interface AnthropicImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

export type AnthropicContentBlock = AnthropicTextBlock | AnthropicImageBlock;

export interface AnthropicWireMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
}

// ---------------------------------------------------------------------------
// System blocks -> AnthropicTextBlock[]
// ---------------------------------------------------------------------------

/**
 * Convert AssembledPrompt.system_blocks to Anthropic system format.
 * Preserves cache_control exactly as set by the assembler.
 */
export function assembledToAnthropicSystem(
  systemBlocks: SystemBlock[]
): AnthropicTextBlock[] {
  return systemBlocks.map((block) => {
    const out: AnthropicTextBlock = { type: "text", text: block.text };
    if (block.cache_control) {
      out.cache_control = {
        type: "ephemeral",
        ...(block.cache_control.ttl ? { ttl: block.cache_control.ttl } : {}),
      };
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Messages -> AnthropicMessage[]
// ---------------------------------------------------------------------------

/**
 * Convert AssembledPrompt.messages to Anthropic message format.
 *
 * String content becomes a text block. OpenAI-style data URL image_url parts
 * become Anthropic image blocks; unknown structured parts stay visible as text.
 */
export function assembledToAnthropicMessages(
  messages: AssembledPrompt["messages"]
): AnthropicWireMessage[] {
  const result: AnthropicWireMessage[] = [];

  for (const msg of messages) {
    const role = msg.role;
    const blocks = contentToAnthropicBlocks(msg.content);

    const prev = result[result.length - 1];
    if (prev?.role === role) {
      prev.content.push(...blocks);
      continue;
    }

    result.push({ role, content: blocks });
  }

  if (result.length === 0) {
    result.push({ role: "user", content: [{ type: "text", text: "" }] });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  const json = JSON.stringify(value);
  return json ?? String(value);
}

function dataUrlToAnthropicImage(url: string): AnthropicImageBlock | null {
  const match = url.match(/^data:(image\/(?:png|jpe?g|gif|webp));base64,(.+)$/i);
  if (!match) return null;

  const mediaType = match[1].toLowerCase() === "image/jpg" ? "image/jpeg" : match[1].toLowerCase();
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: mediaType,
      data: match[2].replace(/\s/g, "")
    }
  };
}

function getImageUrl(part: Record<string, unknown>): string | null {
  if (typeof part.url === "string") return part.url;
  if (isRecord(part.image_url) && typeof part.image_url.url === "string") return part.image_url.url;
  return null;
}

function getAnthropicImageBlock(part: Record<string, unknown>): AnthropicImageBlock | null {
  if (part.type === "image_url") {
    const url = getImageUrl(part);
    return url ? dataUrlToAnthropicImage(url) : null;
  }

  if (part.type !== "image" || !isRecord(part.source)) return null;
  const source = part.source;
  if (source.type !== "base64") return null;
  if (typeof source.media_type !== "string" || typeof source.data !== "string") return null;

  return {
    type: "image",
    source: {
      type: "base64",
      media_type: source.media_type,
      data: source.data
    }
  };
}

export function contentToAnthropicBlocks(content: string | unknown[] | null): AnthropicContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (content == null) return [{ type: "text", text: "" }];
  if (!Array.isArray(content)) return [{ type: "text", text: stringifyUnknown(content) }];

  const blocks: AnthropicContentBlock[] = [];
  for (const part of content) {
    if (isRecord(part)) {
      if (part.type === "text" && typeof part.text === "string") {
        blocks.push({ type: "text", text: part.text });
        continue;
      }

      const imageBlock = getAnthropicImageBlock(part);
      if (imageBlock) {
        blocks.push(imageBlock);
        continue;
      }
    }

    blocks.push({ type: "text", text: stringifyUnknown(part) });
  }

  return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}
