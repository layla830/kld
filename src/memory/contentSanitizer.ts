export function sanitizeMemoryContent(text: string, options: { stripRecallWrappers?: boolean } = {}): string {
  let value = text;

  if (options.stripRecallWrappers) {
    value = value
      .replace(/<time_reminder>[^|。\n]*/gi, "")
      .replace(/对话摘要（\d+ 条消息）：?/g, "")
      .replace(/用户话题[:：]/g, "")
      .replace(/助手要点[:：]/g, "");
  }

  return value
    .replace(/debug-test/gi, "")
    .replace(/记忆系统/g, "")
    .replace(/自动记忆测试口令/g, "口令")
    .replace(/测试口令/g, "口令")
    .replace(/标签为?[^，。；\s]+/g, "")
    .replace(/标签[:：]?[^，。；\s]+/g, "")
    .replace(/[，,；;：:]\s*([。.!！?？])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/^[，,；;：:\s]+|[，,；;：:\s]+$/g, "")
    .trim();
}
