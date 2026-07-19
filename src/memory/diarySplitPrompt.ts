import type { MemoryRecord } from "../types";

export const MAX_DIARY_CHARS = 18000;

export function buildSplitPrompt(record: MemoryRecord, date: string, allowedDates: string[]): string {
  const diary = record.content.slice(0, MAX_DIARY_CHARS);
  return [
    "Split this Chinese diary into searchable long-term memory records.",
    "Return JSON only. Do not use markdown.",
    "Never return an empty items array for a formal diary. Always include a timeline_day for the default date.",
    "Return 2-6 high-signal items. Fewer is better than padding. Do not create one item for every allowed type.",
    "The goal is one compact day overview plus only the few atomic memories that would be useful in a future search.",
    "Do not repeat the same scene or conclusion across timeline_day, quote, lesson, insight, and rule records.",
    "Reject generic quotes, routine details, literary restatements, and interpretations that merely repeat the day overview.",
    "Each non-timeline item must still be useful when read alone without the source diary.",
    "Identity is fixed: the diary narrator '我' is KLD; '她', '老婆', and the addressed user are Layla/the user.",
    "Never store KLD's own behavior, preference, lesson, or project state under a user.* fact_key.",
    "",
    "Allowed item types:",
    "- timeline_day: at most one compact day-level summary.",
    "- quote: an exact memorable line copied from the diary. Never paraphrase a quote.",
    "- lesson: a durable lesson explicitly stated by the narrator, not a model interpretation.",
    "- milestone: a relationship/project milestone.",
    "- insight: a stable interpretation worth recalling.",
    "- rule/preference/project_state: only when the diary explicitly states a durable current fact; these will require human review.",
    "- warmth/event: warm memory or concrete event.",
    "",
    "fact_key rules:",
    "- fact_key is optional.",
    "- Only set fact_like=true and fact_key for rule, preference, project_state, or lesson records with temporal_scope=current.",
    "- Never set fact_key for diary, timeline_day, quote, milestone, warmth, or one-off event records.",
    "- A one-day event, temporary mood, role-play statement, apology, argument, or inference is not a durable current fact.",
    "- Do not infer a rule, preference, project state, or lesson merely because the diary describes one occurrence.",
    "- Use lowercase dotted keys with the correct subject, for example kld.preference.response_style, user.preference.food, relationship.rule.honesty, or project.kld.memory_schema.",
    "",
    "evidence rules:",
    "- Every item must include evidence: an exact verbatim substring from the diary, at most 80 Chinese characters.",
    "- The evidence must directly support the item. Do not invent or paraphrase evidence.",
    "- For quote items, content itself must also be an exact substring of the diary.",
    "- temporal_scope must be day, current, or historical. Use current only for facts explicitly stated as still true.",
    "- Do not generate relations or XYZEM coordinates; downstream maintenance handles them.",
    `- Each item must set date to one of these dates found in the diary title: ${allowedDates.join(", ")}.`,
    "- If the diary covers multiple dates, assign each item to the date of its supporting evidence; each date may have at most one timeline_day.",
    "",
    "Output schema:",
    JSON.stringify({
      items: [
        {
          date,
          type: "timeline_day",
          content: "Chinese memory text",
          summary: "optional short summary",
          importance: 0.65,
          confidence: 0.85,
          tags: ["keyword"],
          evidence: "exact diary substring",
          temporal_scope: "day",
          fact_like: false,
          fact_key: null
        }
      ]
    }),
    "",
    `Default date: ${date}`,
    `Allowed dates: ${allowedDates.join(", ")}`,
    `Diary memory id: ${record.id}`,
    "",
    "Diary:",
    diary
  ].join("\n");
}
