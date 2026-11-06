export const VIDEO_TITLE_SYMBOL_RULE: string
export function normalizeVideoTitle(title: string): string
export function hasSupportedVideoTitleSymbols(title: string): boolean
export function getVideoTitleWarnings(title: string, maxLength: number, label: string): string[]
