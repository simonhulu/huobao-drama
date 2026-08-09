# Violent Search (暴力搜索)

Run after the new topic is confirmed and before the creative contract. In original mode, run it
after the original structure dissection is ready; in generate mode, run it directly from the
confirmed topic and its evidence boundary. This is the information-density engine of the entire workflow.
A script's information density is determined here, not in writing.

## Principle

Facts first, writing second. Every sentence in the final script must carry at least
one specific fact (number, name, date, place, action). If the fact pool is thin, the
script will be filled with scene-setting and commentary regardless of writing skill.

A thin fact pool → thin script. A dense fact pool → dense script. This step is the
single highest-leverage quality investment in the workflow.

Design every search lane from the confirmed new topic and its abstract story needs. In original
mode, include the needs of the dissected skeleton. In generate mode, use the topic's main hole,
likely causal turns, audience, and target duration as provisional structure slots. Never search for
replacement wording or reuse the original's facts.

## Method

Launch 5–8 parallel search agents, each targeting one dimension. Every agent returns
concrete facts with sources — never summaries, never generalizations.

### Search Dimensions

| Agent | Dimension | What to Find | Minimum Output |
|-------|-----------|-------------|----------------|
| 1 | Core Event Details | Specific dates, numbers, people, actions, locations of the central event | 15+ facts |
| 2 | Opposition/Controversy | Conflicting accounts, disputed facts, who disagrees and why | 10+ facts |
| 3 | Personal Stories | Named individuals' recorded experiences: memoirs, oral histories, letters | 10+ facts |
| 4 | Scene/Sensory Details | Physical environment: objects, sounds, smells, textures, weather, light | 10+ facts |
| 5 | Cause-Effect Chain | What caused this, what resulted, direct vs root causes | 10+ facts |
| 6 | Present-Day Echoes | Modern parallels, analogous situations, 借古讽今 targets | 8+ facts |
| 7 | Obscure/Surprising Facts | What most people don't know — counterintuitive details, hidden connections | 10+ facts |
| 8 | Numbers/Data | All available statistics: population, money, time spans, ratios, rates | 10+ facts |

### Agent Instructions

Each agent MUST:
- Return facts, not summaries. "1924年北京停发旗饷，最后一笔仅铜元50枚" is a fact. "民国初年旗人经济困难" is a summary — discard.
- Cite a specific source for every fact (URL, book title + page, document name).
- Favor primary sources over secondary summaries.
- Mark confidence: `confirmed` (multiple sources agree) / `single_source` / `disputed`.
- Never fabricate. If a dimension yields nothing, report empty — never invent.

### Output Format

Each agent returns a structured list:

```
## Agent N: [Dimension]

### F1
- Fact: [one specific sentence with concrete detail]
- Source: [URL or citation]
- Confidence: [confirmed|single_source|disputed]

### F2
...
```

## Output

All agent outputs are written to `scripts/polish-notes/<article-id>/01-raw-search/`
as individual files (`agent-1-core-events.md` through `agent-8-numbers.md`).

The raw search directory is the input to Step 2 (Fact Curation). It is never loaded
into the main session — only the curation agent reads it.

## Token Discipline

- Raw search results stay on disk. The main session never sees them.
- Only the curation agent (Step 2) reads the raw search files.
- The curation agent's output (filtered fact pool) is the only artifact that enters
  downstream steps.
