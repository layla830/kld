function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function buildVectorId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  const suffix = fnv1a(id);
  const prefix = safe.slice(0, Math.max(1, 64 - "mem__".length - suffix.length));
  return `mem_${prefix}_${suffix}`;
}
