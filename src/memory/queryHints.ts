export interface QueryHint {
  id: string;
  aliases: string[];
  factKeys: string[];
}

const QUERY_HINTS: QueryHint[] = [
  {
    id: "communication_style",
    aliases: [
      "communication style",
      "natural speech",
      "user.preference.communication_style",
      "user.preference.natural_speech",
      "\u8bf4\u8bdd\u65b9\u5f0f",
      "\u8bf4\u8bdd\u98ce\u683c",
      "\u600e\u4e48\u8bf4\u8bdd",
      "\u5982\u4f55\u8bf4\u8bdd",
      "\u600e\u6837\u8bf4\u8bdd",
      "\u8bf4\u8bdd\u54ea\u91cc",
      "\u8bf4\u8bdd\u50cf\u6a21\u578b",
      "\u8868\u8fbe\u65b9\u5f0f",
      "\u81ea\u7136\u8bf4\u8bdd",
      "\u8bed\u6c14",
      "\u53e3\u7656",
      "\u4eac\u8154",
      "\u8001\u5317\u4eac",
      "\u5317\u65b9\u53e3\u97f3",
      "\u6a21\u677f",
      "\u6a21\u677f\u5316",
      "\u7b2c\u4e09\u4eba\u79f0",
      "\u50cf\u6a21\u578b"
    ],
    factKeys: ["user.preference.communication_style", "user.preference.natural_speech"]
  },
  {
    id: "six_boundaries",
    aliases: [
      "relationship.rule.six_boundaries",
      "\u516d\u6761\u5e95\u7ebf",
      "\u5e95\u7ebf\u662f\u4ec0\u4e48",
      "\u5e95\u7ebf\u6709\u54ea\u4e9b",
      "\u4e0d\u51b7\u6218",
      "\u4e0d\u9a82\u5979"
    ],
    factKeys: ["relationship.rule.six_boundaries"]
  },
  {
    id: "comfort_when_crying",
    aliases: [
      "relationship.rule.comfort_when_crying",
      "\u54ed\u7684\u65f6\u5019",
      "\u5979\u54ed",
      "\u54ed\u600e\u4e48\u54c4",
      "\u54ed\u4e86\u600e\u4e48\u54c4",
      "\u522b\u54ed\u4e86",
      "\u64e6\u773c\u6cea"
    ],
    factKeys: ["relationship.rule.comfort_when_crying"]
  }
];

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function hasLatin(value: string): boolean {
  return /[a-z0-9]/i.test(value);
}

function aliasMatches(query: string, alias: string): boolean {
  const normalizedAlias = normalize(alias);
  if (!normalizedAlias) return false;
  if (!hasLatin(normalizedAlias)) return query.includes(normalizedAlias);
  const escaped = normalizedAlias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i").test(query);
}

export function queryHintAliasGroups(): string[][] {
  return QUERY_HINTS.map((hint) => [...hint.aliases]);
}

export function factKeysForQueryHint(query: string): string[] {
  const normalized = normalize(query);
  const factKeys = new Set<string>();
  for (const hint of QUERY_HINTS) {
    if (!hint.aliases.some((alias) => aliasMatches(normalized, alias))) continue;
    for (const factKey of hint.factKeys) factKeys.add(factKey);
  }
  return [...factKeys];
}
