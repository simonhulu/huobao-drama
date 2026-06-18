# Plan: Fix Task Center — restore text + panel display

## Root Cause
1. **No text**: compact mode template only renders mark+pulse+count, no "任务中心" label
2. **Broken panel**: TaskCenter was moved inside `.studio-topbar` which has `backdrop-filter: blur(16px)`. Per CSS spec, `backdrop-filter` creates a containing block that traps `position: fixed` children, causing the panel overlay to misrender.

## Fix Strategy
Move TaskCenter back to original position — as direct child of `.studio` (which has NO backdrop-filter), sibling of `.studio-body`. Increase FAB `bottom` offset to clear the step-bubble.

## Steps (sequential)

### Step 1: Move TaskCenter back in episode page
**File**: `frontend/app/pages/drama/[id]/episode/[episodeNumber].vue`

- Remove `<TaskCenter compact ...>` from `.studio-topbar-side` (lines 33-43)
- Insert `<TaskCenter ...>` (without `compact` prop) after `</div>` closing studio-body (after line 1501), before `</div>` closing `.studio` (line 1502)
- Keep all props/event handlers identical

### Step 2: Increase FAB bottom offset
**File**: `frontend/app/components/TaskCenter.vue`

- Change `.task-center-fab:not(.is-compact)` `bottom: 22px` → `bottom: 70px`  
  (step-bubble bar is ~60px; 70px clears it with margin)

### Step 3: Fix compact template text (correctness)
**File**: `frontend/app/components/TaskCenter.vue`

- In compact button template (lines 15-20): add `<strong>任务中心</strong>` text label after the mark span, before count badge
- Keep existing mark + pulse + count

### Step 4: Rebuild + verify
```bash
cd frontend && npm run build
```

## Success Criteria
1. "任务中心" text visible on button
2. Panel overlay opens correctly
3. "下一步" button not obstructed
4. `npm run build` passes
