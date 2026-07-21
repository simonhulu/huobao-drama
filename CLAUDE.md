@AGENTS.md

# Claude Code / OpenCode Specific Notes

## Tooling Preferences

- Use **gstack** `/browse` skill for all web browsing and QA testing.
- Do not use `mcp__claude-in-chrome__*` tools.
- Use the `frontend` skill for any UI/UX/design work.
- Use the `git-master` skill for non-trivial git operations.
- Use the `review-work` skill after significant implementation.

## Planning & Review

- For multi-step features, write a plan first and wait for user confirmation before coding.
- For complex architecture decisions, consult the `oracle` agent.
- After finishing significant work, run verification commands and report concrete results (e.g., "typecheck clean", "142/142 tests pass").

## Cost-Efficient Delegation (Planner-Executor Split)

Inspired by oh-my-openagent. The goal: keep expensive Opus tokens on planning and
sign-off, push implementation tokens to cheaper Sonnet.

- **Opus (main session) owns**: intent classification, planning, task decomposition,
  delegation, and final verification/sign-off. Keep these turns short.
- **`omo-executor` (Sonnet subagent) owns**: actual implementation. Delegate scoped
  coding tasks to it via the Task tool. It runs in its own context, so the files it
  reads and the code it writes do NOT consume Opus tokens — Opus only reads its
  compact structured report.

### When to delegate

- Clear, scoped implementation tasks (add a feature, fix a bug, refactor a module) →
  delegate to `omo-executor`.
- Broad codebase research/search → delegate to `code-explorer` or `Explore` (also Sonnet).
- Trivial one-line edits, or tasks needing full conversation context → Opus does them
  directly (delegation overhead is not worth it).

### Workflow

1. Opus classifies intent and writes a short plan. For multi-step features, confirm
   the plan with the user first (per Planning & Review above).
2. Opus delegates each scoped task to `omo-executor` with a precise task description:
   what to change, which files/patterns to follow, how to verify.
3. `omo-executor` implements, runs verification, returns a compact report
   (STATUS / FILES CHANGED / VERIFICATION / CONCERNS).
4. Opus reviews the report (and requests the diff only if needed), then either signs
   off or sends a correction back to `omo-executor`. Opus owns the quality gate.
5. Opus reports the verified result to the user.

Never let the executor expand scope, re-plan, or commit. Those are Opus decisions.

## Project-Specific Reminders

- The frontend is **Nuxt 3**, not plain Vite. Do not rely on the stale "Vite" description from older docs.
- Episode records use `aspect_ratio` (snake_case) in DB and API responses; access it as `episode.value?.aspect_ratio` in the frontend.
- Task system is central to all long-running AI/media operations. When adding async work, register a handler in `backend/src/services/tasks/handlers/` and enqueue via `creation_tasks`.
- The monolithic `frontend/app/pages/drama/[id]/episode/[episodeNumber].vue` is a known hot spot. Prefer extracting new UI into `frontend/app/components/` or composables.

## Session Safety

- Do not commit unless explicitly asked.
- Do not suppress type errors with `as any` or `@ts-ignore`.
- Do not delete failing tests to make the suite pass.
- Do not leave code in a broken state.
