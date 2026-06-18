# Plan: Vertical Video (9:16) Support

## Goal
Add portrait/vertical video support. User selects orientation when creating episode.
Existing 16:9 landscape remains default. 9:16 vertical is the new option.

## Current State
- `AspectRatio = '16:9' | '9:16'` type already defined in `aspect.ts`
- `ratioToSize()` / `ratioToDimensions()` / `normalizeAspect()` all handle 9:16 ✅
- Video adapters (MiniMax/Vidu/Ali/Seedance) all handle 9:16 ✅
- Image adapters handle sizes correctly if aspect ratio is passed ✅
- **BLOCKER**: `ffmpeg-compose.ts` hardcodes `1920×1080` for Ken Burns
- `episodes.aspect_ratio` column exists but is never read/written
- Frontend never passes aspect ratio anywhere

## Task Graph

```
Wave 1 (parallel):
├── T1: Backend episode create accept aspect_ratio
└── T2: Frontend episode create add aspect ratio selector

Wave 2 (after Wave 1):
├── T3: Frontend genShotFrame pass aspect_ratio
└── T4: Frontend genVid pass aspect_ratio

Wave 3 (parallel, after Wave 2):
├── T5: Parameterize ffmpeg-compose Ken Burns (CRITICAL)
├── T6: Parameterize grid cell dimensions (backend)
└── T7: Parameterize grid call from frontend

Wave 4 (after Wave 3):
├── T8: Storyboard breaker SKILL.md inject orientation
└── T9: Grid prompt tools orientation-aware

Wave 5 (after Wave 4):
└── T10: Build + typecheck verification
```

---

## Wave 1: Foundation — UI → DB

### T1: Backend episode create accept aspect_ratio
**File**: `backend/src/routes/episodes.ts`
**Category**: `quick`

- In episode create POST handler (~line 10-45), add `aspect_ratio` extraction from body:
  ```ts
  import { normalizeAspect } from '../utils/aspect'
  const aspectRatio = normalizeAspect(body.aspect_ratio) ?? '16:9'
  ```
- Include `aspect_ratio: aspectRatio` in the INSERT values (currently missing)
- Do not change episode update route unless needed

### T2: Frontend episode create add aspect ratio selector
**File**: `frontend/app/pages/drama/[id]/index.vue`
**Category**: `visual-engineering`, skills: [`frontend`]

- In episode create dialog (~line 214), add radio group:
  ```html
  <div class="form-group">
    <label>画面方向</label>
    <div class="radio-group">
      <label class="radio"><input type="radio" v-model="newEpisodeAspect" value="16:9" /> 横屏 16:9</label>
      <label class="radio"><input type="radio" v-model="newEpisodeAspect" value="9:16" /> 竖屏 9:16</label>
    </div>
  </div>
  ```
- Add `const newEpisodeAspect = ref('16:9')` in script
- Include `aspect_ratio: newEpisodeAspect.value` in POST body
- Style to match existing form conventions

---

## Wave 2: Wire through generation calls

### T3: Frontend genShotFrame pass aspect_ratio
**File**: `frontend/app/pages/drama/[id]/episode/[episodeNumber].vue`
**Category**: `quick`

- In `genShotFrame()` (~line 2985): add `aspect_ratio: episodeData.aspectRatio || '16:9'` to image generation body

### T4: Frontend genVid pass aspect_ratio
**File**: `frontend/app/pages/drama/[id]/episode/[episodeNumber].vue`
**Category**: `quick`

- In `genVid()` (~line 3068): add `aspect_ratio: episodeData.aspectRatio || '16:9'` to video generation body

---

## Wave 3: Fix hardcoded dimensions

### T5: Parameterize ffmpeg-compose Ken Burns (CRITICAL)
**File**: `backend/src/services/ffmpeg-compose.ts`
**Category**: `quick`

- Import `ratioToDimensions` from `../utils/aspect`
- Add `aspectRatio?: string` to `buildVideoFromImage()` params signature
- Lines 83-84: Replace `const scaleW = Math.round(1920 * 1.08)` / `scaleH = Math.round(1080 * 1.08)` with dimension-aware values
- Line 96: Replace `s=1920x1080` in zoompan with dynamic dimensions
- Line ~357: Make subtitle FontSize proportional instead of hardcoded 20

### T6: Parameterize grid cell dimensions (backend)
**File**: `backend/src/routes/grid.ts`
**Category**: `quick`

- Import `ratioToDimensions` from `../utils/aspect`
- Lines 567-570: Replace hardcoded `cellW=960, cellH=540` with aspect-aware calculation:
  ```ts
  const dims = ratioToDimensions(aspectRatio || '16:9')
  const cellW = Math.round(dims.w / 2)
  const cellH = Math.round(dims.h / 2)
  ```

### T7: Parameterize grid call from frontend
**File**: `frontend/app/pages/drama/[id]/episode/[episodeNumber].vue`
**Category**: `quick`

- Find grid generation API call and add `aspect_ratio: episodeData.aspectRatio || '16:9'`

---

## Wave 4: AI prompt awareness

### T8: Storyboard breaker SKILL.md
**File**: `skills/storyboard_breaker/SKILL.md`
**Category**: `writing`

- Add orientation guidance section

### T9: Grid prompt tools orientation-aware
**File**: `backend/src/agents/tools/grid-prompt-tools.ts`
**Category**: `quick`

- Inject orientation context into grid image prompts

---

## Wave 5: Verification

### T10: Build + typecheck
```bash
cd backend && npm run typecheck && npm test
cd frontend && npm run build
```

---

## Success Criteria
1. User selects 横屏/竖屏 when creating episode
2. Aspect ratio stored in DB
3. Storyboard images at correct dimensions
4. AI video gen passes correct aspect ratio
5. FFmpeg Ken Burns outputs correct resolution
6. Grid images use correct cell sizes
7. Storyboard prompts are orientation-aware
8. Both builds pass with zero errors
