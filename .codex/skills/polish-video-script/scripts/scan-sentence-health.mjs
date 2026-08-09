#!/usr/bin/env node

// Mechanical 病句 scan. Catches the subset of sentence-health failures a machine can decide
// without understanding the sentence; the judgment calls belong to
// agents/sentence-health-auditor.md.
//
// Every rule here was derived from a real defect that shipped in a draft:
//   「退到楼上无路可退」      repeated 退 in 8 characters
//   「人在半空中了弹」        中弹 lost its 中 to 半空中
//   「那年三十二岁」          no subject
//   「宅子…叫恒知府胡同」     叫 attached to the wrong subject
//
// Usage:
//   node scan-sentence-health.mjs --script <final.md> [--json]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const SENTENCE_SPLIT = /(?<=[。！？!?])/;

// Atomic verb-object compounds whose first character is easily swallowed by a preceding
// locative (半空中 + 中弹 → 半空中了弹).
const SWALLOWABLE = [
  { compound: "中弹", head: "中" },
  { compound: "中枪", head: "中" },
  { compound: "中毒", head: "中" },
  { compound: "中招", head: "中" },
  { compound: "上任", head: "上" },
  { compound: "上书", head: "上" },
  { compound: "下狱", head: "下" },
  { compound: "下野", head: "下" },
  { compound: "过关", head: "过" },
  { compound: "起兵", head: "起" }
];

// Characters that carry a locative/temporal reading and can absorb the head above.
const LOCATIVE_TAILS = ["中", "上", "下", "里", "内", "外", "前", "后", "间"];

// Function words: repetition of these is normal Chinese, not a defect.
const REPEAT_WHITELIST = new Set([
  "的", "了", "是", "在", "有", "和", "与", "也", "都", "不", "就", "他", "她", "它",
  "我", "你", "这", "那", "个", "人", "一", "上", "下", "来", "去", "到", "把", "被",
  "说", "年", "月", "日", "时", "又", "还", "很", "更", "最", "会", "能", "要", "没"
]);

// Building/place nouns and the name suffixes that reveal a mis-attached 叫.
const BUILDING_NOUNS = ["宅子", "宅", "房子", "屋子", "院子", "楼", "府", "庄", "店", "铺", "厂", "馆"];
const PLACE_NAME_SUFFIX = ["胡同", "巷", "街", "路", "道", "村", "屯", "镇", "县", "府", "城", "关", "口", "桥"];

function splitParagraphs(text) {
  return text
    .replace(/\r\n/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function splitSentences(paragraph) {
  return paragraph.split(SENTENCE_SPLIT).map((s) => s.trim()).filter(Boolean);
}

// Strip scaffolding LINE BY LINE, not block by block. Drafts carry a beat comment above the
// prose in the same block (「<!-- A1 设问 hot -->\n巴格达城外…」), so judging whole blocks by
// their first line skipped every annotated paragraph — on a real draft that silently hid 10 of
// 15 paragraphs, including a 病句 the account owner had reported by hand.
function isScaffoldLine(line) {
  const trimmed = line.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.startsWith("#")) return true;
  if (trimmed.startsWith("<!--") || trimmed.startsWith("-->")) return true;
  if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) return true;
  if (trimmed.startsWith("|")) return true;
  if (/^-{3,}$/.test(trimmed)) return true;
  if (/^[a-z_]+:/i.test(trimmed) && !/[。！？]/.test(trimmed)) return true;
  return false;
}

function proseOf(paragraph) {
  return paragraph
    .split("\n")
    .filter((line) => !isScaffoldLine(line))
    .join("\n")
    .trim();
}

// Repetition inside or across a repeated proper noun is not a defect: 「这条胡同，叫恒知府胡同」
// legitimately says 胡同 twice. Only flag repetition of ACTION characters — the defect class is
// 「退到楼上无路可退」, a verb reused because the sentence was over-compressed.
const ACTION_REPEAT_WATCHLIST = new Set([
  "退", "跳", "跃", "逃", "躲", "藏", "打", "杀", "砸", "推", "拉", "拖", "抓", "扑",
  "冲", "闯", "撞", "破", "断", "折", "压", "逼", "困", "围", "堵", "拦", "锁", "关",
  "摸", "掏", "举", "扔", "丢", "抛", "踢", "踩", "跨", "翻", "爬", "滚", "摔", "倒",
  "喊", "叫", "哭", "笑", "骂", "求", "跪", "拜", "叩", "磕"
]);

function checkRepeatedChar(sentence) {
  const findings = [];
  const chars = [...sentence].filter((c) => /[一-鿿]/.test(c));
  const WINDOW = 10;
  const seen = new Map();
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i];
    if (REPEAT_WHITELIST.has(c)) continue;
    if (!ACTION_REPEAT_WATCHLIST.has(c)) continue;
    const prev = seen.get(c);
    if (prev !== undefined && i - prev < WINDOW) {
      // Adjacent duplication (中中, 说说) is a different phenomenon — often correct grammar
      // (人在半空中中了弹) or intentional reduplication. Not this rule's business.
      if (i - prev === 1) {
        seen.set(c, i);
        continue;
      }
      findings.push({
        rule: "repeated-char",
        detail: "动作字「" + c + "」在 " + (i - prev + 1) + " 字内出现两次",
        repair: "换掉其中一处的说法，例如「退到楼上无路可退」→「退上二楼，没路了」"
      });
      seen.delete(c);
      continue;
    }
    seen.set(c, i);
  }
  return findings;
}

function checkSwallowedVerb(sentence) {
  const findings = [];
  for (const { compound, head } of SWALLOWABLE) {
    // The defect looks like: <locative ending in head><particle>了<object>, with the compound
    // itself absent — e.g. 半空中了弹 where 中弹 should appear.
    const tail = compound.slice(1);
    // The defect is one character doing two jobs: 「人在半空中了弹」 uses 中 to close the
    // locative 半空中 AND as the head of 中弹. So the trigger is a LOCATIVE PHRASE whose final
    // character is this compound's head — 在…中/上/下/里 — immediately followed by 了 + object.
    //
    // Plain 「他中了毒」/「袁世凯上了任」 must NOT fire: there is no locative phrase, 中 is just
    // the verb, and 了 is its aspect marker. Requiring the 在-phrase is what separates them.
    // Getting this wrong is costly in one direction: writer-pass rule 0 says to repair by
    // adding the missing character, so a false positive here instructs someone to write
    // 「他中中了毒」.
    const broken = new RegExp("在[^，。；：！？]{1,12}" + head + "了" + tail, "u");
    // Bare form: a locative noun ending in the head, then 了 + object (半空中了弹).
    const bareLocative = new RegExp(
      "(?:空|面|间|旁|边|头|底|首|尾|央|内|外)" + head + "了" + tail,
      "u"
    );
    // The correct repair doubles the head (半空中中了弹), which still matches the patterns above
    // — so the doubled form is the definitive signal that nothing was swallowed.
    const headDoubled = sentence.includes(head + head + "了" + tail);
    const swallowed = (broken.test(sentence) || bareLocative.test(sentence)) &&
      !headDoubled &&
      !sentence.includes(compound);
    if (swallowed) {
      findings.push({
        rule: "swallowed-verb",
        detail: "疑似吞字：出现「了" + tail + "」但全句没有「" + compound + "」",
        repair: "补回动词，例如「人在半空中了弹」→「人在半空中中了弹」"
      });
    }
  }
  return findings;
}

function checkMissingSubject(sentence) {
  const findings = [];
  const bare = sentence.replace(/[，。！？、；：""''「」（）()\s]/g, "");
  // 「那年三十二岁」class: a time word plus an age/quantity predicate and no actor anywhere.
  const agePredicate = /(那年|这年|当年|次年|同年)[^，。]{0,6}(\d|[一二三四五六七八九十百]+)+(岁|年)/u;
  if (agePredicate.test(sentence)) {
    const hasActor = /(他|她|我|你|人|[一-鿿]{2,4}(?:氏|某))/u.test(
      sentence.replace(agePredicate, "")
    );
    if (!hasActor) {
      findings.push({
        rule: "missing-subject",
        detail: "年龄陈述没有主语",
        repair: "补主语，例如「那年三十二岁」→「那年，他三十二岁」"
      });
    }
  }
  // A sentence that is only a predicate fragment: starts with a verb-ish particle and is short.
  if (bare.length > 0 && bare.length <= 8 && /^(被|把|将|让|使|叫)/u.test(bare)) {
    findings.push({
      rule: "missing-subject",
      detail: "以介词/被动词开头的短句缺少施事或受事",
      repair: "补上谁对谁做了什么"
    });
  }
  return findings;
}

function checkMisattachedNaming(sentence) {
  const findings = [];
  // 「宅子在…，叫X胡同」: the naming clause's implied subject is the building, but the name is
  // a place name. Only fires when a building noun precedes and no place noun intervenes.
  const namingMatch = /[，,]\s*叫([一-鿿]{2,8})/u.exec(sentence);
  if (!namingMatch) return findings;
  const name = namingMatch[1];
  const endsWithPlace = PLACE_NAME_SUFFIX.some((suffix) => name.endsWith(suffix));
  if (!endsWithPlace) return findings;

  const before = sentence.slice(0, namingMatch.index);
  // `叫` with no subject of its own attaches to the clause topic — the noun in subject
  // position, not any place word that happens to appear inside the address. In
  // 「宅子在大东关小什字街，叫恒知府胡同」 the topic is 宅子 and 小什字街 is only the address,
  // so the sentence claims the house is named 恒知府胡同.
  const clause = before.split(/[，,；;：:]/)[0] || "";
  // The subject is what precedes the locative verb, not the address that follows it. In
  // 「宅子在大东关小什字街」 the subject is 宅子 and 小什字街 is only where it sits — reading the
  // whole clause would let the address's 街 masquerade as the thing being named.
  const subject = clause.split(/[在位于坐落]/)[0] || clause;
  const buildingSubject = BUILDING_NOUNS.some((noun) => subject.includes(noun));
  // If the subject is itself the place being named, the attachment is correct.
  const placeSubject = PLACE_NAME_SUFFIX.some((suffix) => subject.endsWith(suffix)) ||
    /(这|那)(条|个|座)/u.test(subject);
  if (buildingSubject && !placeSubject) {
    // Advisory, not a blocker: deciding this needs world knowledge a regex cannot have.
    // 「宅子…叫恒王府」 is correct (a mansion may be called a 府); 「宅子…叫开封府」 is not.
    // 府/城/关 are both building words and place words, so either list produces false
    // positives. The auditor agent owns the verdict; this rule only points at the sentence.
    findings.push({
      rule: "misattached-naming",
      advisory: true,
      detail: "「叫" + name + "」的主语看起来是建筑物，但名字像地名——请人工判断是否错挂",
      repair: "若确实错挂，点明真正的主语：「宅子在大东关小什字街，胡同叫恒知府胡同」"
    });
  }
  return findings;
}

function checkRunawayClause(sentence) {
  const findings = [];
  const chars = [...sentence].filter((c) => /[一-鿿]/.test(c)).length;
  const commas = (sentence.match(/[，,、]/g) || []).length;
  if (chars > 70 && commas >= 6) {
    findings.push({
      rule: "runaway-clause",
      detail: "单句 " + chars + " 字、" + commas + " 个逗号，口播读不完",
      repair: "断成两三句。同一主体的连续动作链可以长，互不从属的动作要断开"
    });
  }
  return findings;
}

export function scanSentenceHealth(scriptText) {
  const findings = [];
  const paragraphs = splitParagraphs(scriptText);
  let paragraphNumber = 0;
  for (const block of paragraphs) {
    const paragraph = proseOf(block);
    if (paragraph.length === 0) continue;
    paragraphNumber += 1;
    for (const sentence of splitSentences(paragraph)) {
      const checks = [
        ...checkRepeatedChar(sentence),
        ...checkSwallowedVerb(sentence),
        ...checkMissingSubject(sentence),
        ...checkMisattachedNaming(sentence),
        ...checkRunawayClause(sentence)
      ];
      for (const finding of checks) {
        findings.push({ paragraph: paragraphNumber, sentence, ...finding });
      }
    }
  }
  return findings;
}

function main() {
  const scriptIndex = process.argv.indexOf("--script");
  const scriptFile = scriptIndex === -1 ? undefined : process.argv[scriptIndex + 1];
  const asJson = process.argv.includes("--json");

  if (!scriptFile) {
    process.stderr.write("Usage: node scan-sentence-health.mjs --script <final.md> [--json]\n");
    process.exitCode = 2;
    return;
  }

  let scriptText;
  try {
    scriptText = fs.readFileSync(path.resolve(scriptFile), "utf8");
  } catch (error) {
    process.stderr.write("Unable to read script: " + error.message + "\n");
    process.exitCode = 2;
    return;
  }

  const findings = scanSentenceHealth(scriptText);
  const blockers = findings.filter((f) => !f.advisory);
  const advisories = findings.filter((f) => f.advisory);

  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        { findings, count: findings.length, blockers: blockers.length, advisories: advisories.length },
        null,
        2
      ) + "\n"
    );
  } else if (findings.length === 0) {
    process.stdout.write("PASS sentence health (mechanical rules)\n");
  } else {
    const render = (f) =>
      "- 段落 " + f.paragraph + " | " + f.rule + " | " + f.detail + "\n" +
      "  句: " + f.sentence + "\n" +
      "  改: " + f.repair + "\n";

    if (blockers.length > 0) {
      process.stderr.write("SENTENCE HEALTH: " + blockers.length + " suspected 病句\n");
      for (const f of blockers) process.stderr.write(render(f));
    }
    if (advisories.length > 0) {
      process.stderr.write(
        (blockers.length > 0 ? "\n" : "") +
          "ADVISORY (人工判断，不阻塞): " + advisories.length + "\n"
      );
      for (const f of advisories) process.stderr.write(render(f));
    }
    process.stderr.write(
      "\nThese are mechanical suspicions, not verdicts — a legitimate colloquial ellipsis may " +
        "appear here. Route them through the sentence-health auditor, and never resolve one by " +
        "compressing further (语法完整 > 压缩密度).\n"
    );
  }

  // Only blockers break the persistence chain; advisories need a human verdict.
  process.exitCode = blockers.length > 0 ? 1 : 0;
}

const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) ===
      fs.realpathSync(new URL(import.meta.url).pathname);
  } catch {
    return false;
  }
})();
if (invokedDirectly) main();
