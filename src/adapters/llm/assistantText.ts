import type { OpenAIChatResponse } from "../../types";

function readTextParts(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
      ? String((part as { text: string }).text)
      : "")
    .join("")
    .trim();
}

export function readAssistantTexts(response: OpenAIChatResponse): string[] {
  const message = response.choices?.[0]?.message as
    | { content?: unknown; reasoning_content?: unknown }
    | undefined;
  return [readTextParts(message?.content), readTextParts(message?.reasoning_content)].filter(Boolean);
}

/**
 * Read content and reasoning separately, preserving which is which.  Unlike
 * readAssistantTexts (a filtered flat array), empty content never shifts the
 * reasoning text into the content slot.
 */
export function readAssistantParts(response: OpenAIChatResponse): {
  content: string;
  reasoning: string;
} {
  const message = response.choices?.[0]?.message as
    | { content?: unknown; reasoning_content?: unknown }
    | undefined;
  return {
    content: readTextParts(message?.content),
    reasoning: readTextParts(message?.reasoning_content)
  };
}
