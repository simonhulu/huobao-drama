# Agents — AI Agent System

## OVERVIEW
Mastra-based AI agent system. Agents are created per-request (not pre-instantiated) to isolate episode/drama context. Tools are closure-captured for runtime data access. Skills loaded from filesystem at runtime.

## STRUCTURE
```
agents/
├── index.ts          # Agent factory: createAgent(type, episodeId?, dramaId?)
├── skills.ts         # Runtime SKILL.md loader from skills/ directory
└── tools/
    ├── extract-tools.ts          # Character/scene extraction
    ├── grid-prompt-tools.ts      # Grid image prompt generation
    ├── narrator-tools.ts         # Narration generation
    ├── script-tools.ts           # Script rewriting
    ├── storyboard-tools.ts       # Storyboard breaking
    └── voice-tools.ts            # Voice assignment
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| Add agent type | `index.ts` → `validAgentTypes` + `getAgentTools()` | 8 types defined |
| Add tool | `tools/<domain>-tools.ts` | Functions returning Mastra tool objects |
| Load skill | `skills.ts` → `loadSkillForAgent()` | Reads `skills/<agent_type>/SKILL.md` |
| Change agent model | DB `agent_configs` table | model, temperature, maxIterations per type |

## CONVENTIONS
- **Per-request Agent factory** — `createAgent(type, episodeId?, dramaId?)` creates fresh instance; context closure-captured.
- **Agent list** — `validAgentTypes` gates accepted types; `getAgentTools()` maps type → tools.
- **Skill loading** — `loadSkillForAgent()` reads SKILL.md at runtime from filesystem. Not cached.
- **Tools per-agent** — each type gets its own tool set; no shared tools across agent types.
- **Chat route** — `POST /api/v1/agent/:type/chat` enqueues task (async) or runs sync with `?debug=1`.
- **Agent memory** — Mastra `Memory` with custom storage, passed on agent creation.

## ANTI-PATTERNS
- **Don't instantiate agents globally** — each request needs fresh Agent for episode/drama isolation.
- **`storyboard_splitter` has no SKILL.md** — in `validAgentTypes` but missing from `AGENT_SKILL_MAP`. Uses storyboard_breaker tools as fallback.
