# Smart Episode Splitting Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a project-page "智能分集" flow that accepts original story text, targets an approximate per-episode duration, extracts a plot progression chain, and creates multiple episodes with cliffhanger-style boundaries.

**Architecture:** Add a drama-level backend service that calls the active text provider's chat-completions API with a strict JSON schema, forcing `deepseek-v4-flash` for this feature. The service first extracts plot beats and then returns episode boundaries plus episode payloads; a new `/api/v1/dramas/:id/smart-split` route persists the generated episodes. The frontend project page gets a dedicated dialog to collect source text, duration preset, and episode config, then submits to the new route and refreshes the episode list.

**Tech Stack:** Hono, Drizzle ORM, SQLite, Nuxt 3, Vue 3, Node test runner, OpenAI-compatible chat completions, Zod

---

### Task 1: Backend contract tests for smart splitting

**Files:**
- Create: `backend/src/routes/drama-smart-split.test.ts`
- Reference: `backend/src/routes/dramas.ts`
- Reference: `backend/src/services/storyboard-prompt-repair.test.ts`

**Step 1: Write the failing route test for successful smart split**

```ts
test('POST /:id/smart-split creates multiple episodes from structured AI output', async () => {
  // seed drama + active text config
  // stub fetch to return a valid structured split payload
  // call dramas route
  // assert created episodes, titles, content, duration, descriptions
})
```

**Step 2: Run test to verify it fails**

Run: `cd backend && node --test src/routes/drama-smart-split.test.ts`
Expected: FAIL because route does not exist yet

**Step 3: Write the failing validation test**

```ts
test('POST /:id/smart-split rejects missing source text or config ids', async () => {
  // assert 400 for invalid body
})
```

**Step 4: Run test to verify it fails**

Run: `cd backend && node --test src/routes/drama-smart-split.test.ts`
Expected: FAIL because validation path does not exist yet

### Task 2: Structured smart-split service

**Files:**
- Create: `backend/src/services/episode-splitter.ts`
- Create: `backend/src/services/episode-splitter.test.ts`
- Modify: `backend/src/services/ai.ts`
- Reference: `backend/src/services/storyboard-prompt-repair.ts`

**Step 1: Write the failing service test for request shape**

```ts
test('splitStoryIntoEpisodes calls deepseek-v4-flash with strict JSON schema', async () => {
  // stub fetch
  // call service
  // assert model === deepseek-v4-flash
  // assert response_format json schema exists
  // assert tools include plot progression extraction shape
})
```

**Step 2: Run test to verify it fails**

Run: `cd backend && node --test src/services/episode-splitter.test.ts`
Expected: FAIL because service does not exist yet

**Step 3: Implement minimal service**

```ts
export async function splitStoryIntoEpisodes(input: SmartSplitInput): Promise<SmartSplitResult> {
  // get text config
  // call chat completions with deepseek-v4-flash
  // force JSON schema output containing plot progression chain + episodes
  // validate and normalize returned object
}
```

**Step 4: Run tests to verify service passes**

Run: `cd backend && node --test src/services/episode-splitter.test.ts`
Expected: PASS

### Task 3: Drama route persistence

**Files:**
- Modify: `backend/src/routes/dramas.ts`
- Modify: `backend/src/index.ts` (only if route wiring needs adjustment)
- Test: `backend/src/routes/drama-smart-split.test.ts`

**Step 1: Implement `POST /:id/smart-split`**

```ts
app.post('/:id/smart-split', async (c) => {
  // validate drama
  // validate text, duration preset, image/video/audio config ids, aspect ratio
  // call splitStoryIntoEpisodes
  // create episodes transactionally with next episode numbers
  // return created episodes + plot progression chain
})
```

**Step 2: Run route tests**

Run: `cd backend && node --test src/routes/drama-smart-split.test.ts`
Expected: PASS

**Step 3: Run related regression tests**

Run: `cd backend && node --test src/routes/episode-auto-start.test.ts src/routes/storyboards.test.ts`
Expected: PASS

### Task 4: Project-page smart split UI

**Files:**
- Modify: `frontend/app/composables/useApi.ts`
- Modify: `frontend/app/pages/drama/[id]/index.vue`

**Step 1: Add failing frontend integration point mentally against current UI contract**

The page currently exposes only "添加集". The new dialog must add:
- original story textarea
- duration preset options
- image/video/audio config selectors
- aspect ratio selector
- submit state and success refresh

**Step 2: Implement API wrapper**

```ts
smartSplit: (id: number, data: any) => api.post(`/dramas/${id}/smart-split`, data)
```

**Step 3: Implement dialog and submit flow**

```vue
<button class="btn" @click="openSmartSplit">智能分集</button>
```

```ts
await dramaAPI.smartSplit(dramaId, {
  source_text,
  duration_preset,
  image_config_id,
  video_config_id,
  audio_config_id,
  aspect_ratio,
})
```

**Step 4: Run frontend validation**

Run: `cd frontend && npm run build`
Expected: PASS

### Task 5: Final verification

**Files:**
- No code changes required

**Step 1: Run backend typecheck**

Run: `cd backend && npm run typecheck`
Expected: PASS

**Step 2: Run targeted backend tests**

Run: `cd backend && node --test src/services/episode-splitter.test.ts src/routes/drama-smart-split.test.ts src/routes/episode-auto-start.test.ts`
Expected: PASS

**Step 3: Confirm dev URLs**

Run: inspect existing frontend/backend dev servers and provide the manual verification URL for the drama page.

**Step 4: Commit**

```bash
git add docs/plans/2026-06-24-smart-episode-splitting.md \
  backend/src/services/episode-splitter.ts \
  backend/src/services/episode-splitter.test.ts \
  backend/src/routes/drama-smart-split.test.ts \
  backend/src/routes/dramas.ts \
  frontend/app/composables/useApi.ts \
  frontend/app/pages/drama/[id]/index.vue
git commit -m "feat: add smart episode splitting"
```
