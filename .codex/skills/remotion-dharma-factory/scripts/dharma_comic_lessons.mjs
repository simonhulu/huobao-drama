import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const lessonByErrorCode = Object.freeze({
  SCRIPT_CHANGED: 'state-recovery.md',
  ORCHESTRATION_FAILED: 'state-recovery.md',
  ENVIRONMENT_INVALID: 'environment.md',
  EPISODE_CREATE_FAILED: 'episode-create.md',
  TTS_TASK_FAILED: 'tts-clone.md',
  TTS_CLONE_INVALID: 'tts-clone.md',
  TTS_TIMELINE_MISMATCH: 'tts-timeline.md',
  MANIFEST_PLAN_FAILED: 'manifest.md',
  MANIFEST_INVALID: 'manifest.md',
  MANIFEST_CHANGED: 'manifest.md',
  IMAGE_DEPENDENCY_BLOCKED: 'manifest.md',
  IMAGE_SUBMISSION_FAILED: 'image-tasks.md',
  IMAGE_TASK_FAILED: 'image-tasks.md',
  IMAGE_RETRY_EXHAUSTED: 'image-tasks.md',
  ASSET_INVALID: 'asset-validation.md',
  ASSET_CONTACT_SHEET_FAILED: 'asset-validation.md',
  PROPS_BUILD_FAILED: 'frame-layout.md',
  FRAME_RENDER_FAILED: 'frame-layout.md',
  FRAME_REJECTED: 'frame-layout.md',
  DELIVERY_EXISTS_UNOWNED: 'render-recovery.md',
  NATIVE_RESULT_INVALID: 'render-recovery.md',
  RENDER_FAILED: 'render-recovery.md',
  EPISODE_PUBLISH_FAILED: 'episode-publish.md',
  DELIVERY_VERIFICATION_FAILED: 'delivery-verification.md',
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
