const QUERY_NOISE_PATTERNS = [
  /你还记得/g,
  /还记得/g,
  /记不记得/g,
  /记得/g,
  /记住/g,
  /想起来/g,
  /回忆/g,
  /印象/g,
  /之前/g,
  /上次/g,
  /以前/g,
  /过去/g,
  /刚才/g,
  /昨天/g,
  /那天/g,
  /当时/g,
  /说过/g,
  /聊过/g,
  /提过/g,
  /存过/g,
  /时候我会说/g,
  /时我会说/g,
  /我会说/g,
  /会说/g,
  /说什么/g,
  /怎么说/g,
  /是什么/g,
  /什么/g,
  /哪个/g,
  /哪里/g,
  /哪儿/g,
  /吗/g,
  /呢/g,
  /呀/g,
  /啊/g,
  /的/g
];

const LEADING_PRONOUN_PATTERN = /^(你们|我们|他们|她们|它们|你|我|她|他|它)+/;
const QUERY_PUNCTUATION_PATTERN = /[?？!！。.,，、:：;；"“”'‘’]/g;

export function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

export function normalizeQueryForMemorySearch(query: string): string {
  let normalized = normalizeText(query).replace(QUERY_PUNCTUATION_PATTERN, " ");
  for (const pattern of QUERY_NOISE_PATTERNS) normalized = normalized.replace(pattern, " ");
  normalized = normalized.replace(/\s+/g, " ").trim();

  let previous = "";
  while (previous !== normalized) {
    previous = normalized;
    normalized = normalized.replace(LEADING_PRONOUN_PATTERN, "").trim();
  }

  return normalized.length >= 2 ? normalized : normalizeText(query);
}

export function chineseNgrams(value: string): string[] {
  const grams: string[] = [];
  for (let size = 2; size <= Math.min(4, value.length); size += 1) {
    for (let index = 0; index <= value.length - size; index += 1) grams.push(value.slice(index, index + size));
  }
  return grams;
}
