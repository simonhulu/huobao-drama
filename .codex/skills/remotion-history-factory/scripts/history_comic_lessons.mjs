import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const lessonByErrorCode = Object.freeze({
  EPISODE_SNAPSHOT_INVALID: 'episode-snapshot.md',
  ENVIRONMENT_INVALID: 'environment.md',
  TTS_TIMELINE_MISMATCH: 'timing-master.md',
  NARRATIVE_PLAN_INVALID: 'narrative-plan.md',
  DESIGN_TASK_FAILED: 'design-tasks.md',
  DESIGN_INCOMPLETE: 'retry-budget.md',
  GENERATE_TASK_FAILED: 'circuit-breaker.md',
  GENERATE_INCOMPLETE: 'generate-incomplete.md',
  IMAGE_RETRY_EXHAUSTED: 'retry-budget.md',
  MANIFEST_BUILD_FAILED: 'manifest.md',
  MANIFEST_INVALID: 'manifest.md',
  MANIFEST_CHANGED: 'manifest.md',
  ASSET_INVALID: 'asset-validation.md',
  ASSET_CONTACT_SHEET_FAILED: 'asset-validation.md',
  ASSET_AUTO_APPROVAL_FAILED: 'asset-validation.md',
  VISUAL_APPROVAL_INVALID: 'asset-validation.md',
  PROPS_BUILD_FAILED: 'props-build.md',
  RENDER_FAILED: 'render-recovery.md',
  NATIVE_RESULT_INVALID: 'render-recovery.md',
  FRAME_RENDER_FAILED: 'frame-review.md',
  FRAME_AUTO_APPROVAL_FAILED: 'frame-review.md',
  DELIVERY_VERIFICATION_FAILED: 'delivery-verification.md',
  DELIVERY_EXISTS_UNOWNED: 'publish.md',
  EPISODE_PUBLISHING_PACKAGE_REQUIRED: 'publish.md',
  EPISODE_PUBLISH_FAILED: 'publish.md',
  RUNNER_VERSION_MISMATCH: 'runner-version.md',
  RUN_LEASE_ACTIVE: 'lease-recovery.md',
  RUN_LEASE_LOST: 'lease-recovery.md',
  RUN_LEASE_OWNERSHIP_MISMATCH: 'lease-recovery.md',
  ACTION_FAILED: 'retry-budget.md',
})

export const mappedFailureCodes = Object.freeze(Object.keys(lessonByErrorCode))

export function lessonPathForErrorCode(errorCode) {
  const filename = lessonByErrorCode[errorCode]
  return filename ? resolve(skillDir, 'references/lessons', filename) : null
}

export function addFailureLesson(status) {
  const checks = { ...(status.checks || {}) }
  delete checks.lesson_path
  if (status.status === 'failed') {
    const lessonPath = lessonPathForErrorCode(status.error_code)
    if (!lessonPath) {
      throw new Error(`Failed status has no lesson mapping: ${status.error_code}`)
    }
    checks.lesson_path = lessonPath
  }
  return { ...status, checks }
}
