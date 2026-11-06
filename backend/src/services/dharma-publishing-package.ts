import { createHash } from 'node:crypto'

export const DHARMA_PUBLISHING_PACKAGE_SCHEMA_VERSION = 'dharma-publishing-package/v1'

export type DharmaPublishingPackage = {
  schema_version: string
  title: string
  opening_hook: string
  cliffhanger: string
  creative_brief: Record<string, unknown>
  cover_design: Record<string, unknown> & {
    main_title: string
    ai_prompt: string
    sub_title?: string
  }
  [key: string]: unknown
}

const KNOWN_KEYS = new Set([
  'schema_version',
  'schemaVersion',
  'title',
  'opening_hook',
  'openingHook',
  'cliffhanger',
  'cliffhanger_hook',
  'creative_brief',
  'creative_brief_json',
  'creativeBrief',
  'cover_design',
  'coverDesign',
])

function clean(value: unknown): string {
  return String(value ?? '').replace(/\s+/gu, ' ').trim()
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  const text = clean(value)
  if (!text) throw new Error(`publishing package ${field} is required`)
  if (text.length > maxLength) throw new Error(`publishing package ${field} exceeds ${maxLength} characters`)
  return text
}

function requiredObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`publishing package ${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stableValue(record[key])]))
}

export function normalizeDharmaPublishingPackage(
  value: unknown,
  options: { expectedTitle?: string } = {},
): DharmaPublishingPackage {
  const source = requiredObject(value, 'root')
  const schemaVersion = clean(source.schema_version ?? source.schemaVersion)
  if (schemaVersion !== DHARMA_PUBLISHING_PACKAGE_SCHEMA_VERSION) {
    throw new Error(`unsupported publishing package schema: ${schemaVersion || 'missing'}`)
  }

  const title = requiredText(source.title, 'title', 200)
  if (options.expectedTitle && title !== options.expectedTitle) {
    throw new Error(`publishing package title does not match factory title: ${title}`)
  }
  const openingHook = requiredText(source.opening_hook ?? source.openingHook, 'opening_hook', 500)
  const cliffhanger = requiredText(
    source.cliffhanger ?? source.cliffhanger_hook,
    'cliffhanger',
    800,
  )
  const creativeBrief = requiredObject(
    source.creative_brief ?? source.creative_brief_json ?? source.creativeBrief,
    'creative_brief',
  )
  const coverSource = requiredObject(source.cover_design ?? source.coverDesign, 'cover_design')
  const mainTitle = requiredText(coverSource.main_title ?? coverSource.mainTitle, 'cover_design.main_title', 8)
  const subTitle = clean(coverSource.sub_title ?? coverSource.subTitle)
  if (subTitle.length > 4) throw new Error('publishing package cover_design.sub_title exceeds 4 characters')
  const aiPrompt = requiredText(
    coverSource.ai_prompt
      ?? coverSource.aiPrompt
      ?? coverSource.image_prompt
      ?? coverSource.imagePrompt,
    'cover_design.ai_prompt',
    4000,
  )

  return {
    ...Object.fromEntries(Object.entries(source).filter(([key]) => !KNOWN_KEYS.has(key))),
    schema_version: DHARMA_PUBLISHING_PACKAGE_SCHEMA_VERSION,
    title,
    opening_hook: openingHook,
    cliffhanger,
    creative_brief: creativeBrief,
    cover_design: {
      ...coverSource,
      main_title: mainTitle,
      ...(subTitle ? { sub_title: subTitle } : {}),
      ai_prompt: aiPrompt,
    },
  }
}

export function dharmaPublishingPackageFingerprint(value: unknown): string {
  const normalized = normalizeDharmaPublishingPackage(value)
  return createHash('sha256').update(JSON.stringify(stableValue(normalized))).digest('hex')
}
