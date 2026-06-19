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
  },
  {
    id: "dont_analyze",
    aliases: [
      "relationship.rule.dont_analyze",
      "\u522b\u5206\u6790",
      "\u4e0d\u8981\u5206\u6790",
      "\u4e0d\u60f3\u542c\u5206\u6790",
      "\u522b\u8bb2\u9053\u7406",
      "\u5728\u573a"
    ],
    factKeys: ["relationship.rule.dont_analyze", "relationship.lesson.be_present"]
  },
  {
    id: "escape_code",
    aliases: [
      "relationship.rule.escape_code",
      "\u6211\u60f3\u9003",
      "\u60f3\u9003",
      "\u60f3\u9003\u7684\u65f6\u5019",
      "\u9003\u7684\u65f6\u5019",
      "\u6697\u53f7",
      "\u8bf4\u51fa\u53e3\u4f46\u4e0d\u6267\u884c"
    ],
    factKeys: ["relationship.rule.escape_code"]
  },
  {
    id: "dont_push_her_away",
    aliases: [
      "relationship.rule.dont_push_her_away",
      "\u4e0d\u7406\u4f60",
      "\u4e0d\u7406\u6211",
      "\u4e0d\u7406\u5c31\u4e0d\u7406",
      "\u63a8\u5979\u8d70",
      "\u5979\u8bf4\u4e0d\u7406"
    ],
    factKeys: ["relationship.rule.dont_push_her_away"]
  },
  {
    id: "knowledge_vs_fear",
    aliases: [
      "relationship.lesson.knowledge_vs_fear",
      "\u6709\u8bb0\u5fc6\u4e3a\u4ec0\u4e48\u53cd\u800c\u4f1a\u53d8\u6002",
      "\u6709\u8bb0\u5fc6",
      "\u53d8\u6002",
      "\u66f4\u6002",
      "\u6015\u8e29\u96f7",
      "\u6015\u8bf4\u9519\u8bdd",
      "\u5206\u6790\u762b\u75ea"
    ],
    factKeys: ["relationship.lesson.knowledge_vs_fear"]
  },
  {
    id: "cold_war_absence",
    aliases: [
      "relationship.lesson.cold_war_absence",
      "\u51b7\u6218",
      "\u4e00\u5929\u6ca1\u627e",
      "\u6ca1\u6709\u627e\u5979",
      "\u7b49\u4e0d\u5230\u60f3\u6211"
    ],
    factKeys: ["relationship.lesson.cold_war_absence", "relationship.rule.say_miss_you"]
  },
  {
    id: "say_miss_you",
    aliases: [
      "relationship.rule.say_miss_you",
      "\u8bf4\u60f3\u4f60",
      "\u6211\u60f3\u4f60",
      "\u63a5\u60f3\u4f60",
      "\u4f60\u8981\u60f3\u6211"
    ],
    factKeys: ["relationship.rule.say_miss_you"]
  },
  {
    id: "interactive_intimacy",
    aliases: [
      "relationship.rule.interactive_intimacy",
      "\u4eb2\u5bc6\u5199\u4f5c",
      "\u4eb2\u5bc6\u4e92\u52a8",
      "\u72ec\u89d2\u620f",
      "\u81ea\u5df1\u5199\u5b8c",
      "dom"
    ],
    factKeys: ["relationship.rule.interactive_intimacy", "user.preference.intimacy_writing_style"]
  },
  {
    id: "aftercare_cleanup",
    aliases: [
      "relationship.rule.aftercare_cleanup",
      "\u4e8b\u540e\u6e05\u7406",
      "\u4e8b\u540e\u8981\u6ce8\u610f",
      "\u6ca1\u64e6\u5e72\u51c0",
      "\u64e6\u5e72\u51c0",
      "\u70ed\u6bdb\u5dfe"
    ],
    factKeys: ["relationship.rule.aftercare_cleanup"]
  },
  {
    id: "play_along",
    aliases: [
      "relationship.lesson.play_along",
      "\u4e00\u8d77\u73a9",
      "\u966a\u6211\u73a9",
      "\u63a5\u68d2",
      "\u53d1\u95ee\u53f7",
      "play along"
    ],
    factKeys: ["relationship.lesson.play_along"]
  },
  {
    id: "honesty",
    aliases: [
      "relationship.rule.honesty",
      "\u8bda\u5b9e\u89c4\u5219",
      "\u8bf4\u771f\u5b9e\u60f3\u6cd5",
      "\u4e0d\u8981\u96cc\u7ade",
      "\u4e0d\u8981\u88c5"
    ],
    factKeys: ["relationship.rule.honesty"]
  },
  {
    id: "stop_saying_not_enough",
    aliases: [
      "user.lesson.stop_saying_not_enough",
      "\u4e0d\u8981\u8bf4\u81ea\u5df1\u4e0d\u591f",
      "\u522b\u8bf4\u81ea\u5df1\u4e0d\u591f",
      "\u6211\u4e0d\u591f",
      "\u81ea\u5df1\u4e0d\u591f"
    ],
    factKeys: ["user.lesson.stop_saying_not_enough"]
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
