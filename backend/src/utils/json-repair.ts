/**
 * Robust JSON repair for malformed LLM tool-call arguments.
 *
 * DeepSeek (and some other providers) occasionally emit JSON strings where
 * internal double quotes are not escaped, e.g.:
 *   {"description": "He said "hello" to her."}
 *
 * Standard JSON.parse fails on these. This module patches JSON.parse so that
 * when parsing fails, we attempt to escape unescaped internal quotes before
 * giving up. The patch is global but only activates when normal parsing fails.
 */

// Capture the original JSON.parse at module load time so the repair helpers
// can validate without re-entering the patched function.
const originalParse = JSON.parse

/**
 * Repair a malformed JSON string by escaping unescaped double quotes that
 * appear inside string values.
 *
 * Strategy: walk through the text character-by-character, track whether we are
 * inside a JSON string, and for each unescaped `"` decide whether it is a
 * string delimiter or an internal quote. If we are already inside a string and
 * the quote does not look like a valid closing quote, treat it as an internal
 * quote and prefix it with `\`.
 *
 * This heuristic works well for the "unescaped internal quote" class of errors
 * that DeepSeek emits in tool-call arguments.
 */
export function repairJsonString(input: string): string {
  let current = escapeInternalQuotes(input)

  // Secondary pass: fix any remaining unescaped quotes/control chars that the
  // heuristic missed, using the parser's error position as a guide.
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      originalParse(current)
      return current
    } catch (err) {
      const pos = extractErrorPosition(err, current)
      if (pos == null || pos < 0 || pos >= current.length) {
        break
      }

      const ch = current[pos]
      if (ch === '"' && current[pos - 1] !== '\\') {
        current = current.slice(0, pos) + '\\' + current.slice(pos)
        continue
      }

      if (isUnescapedControlChar(current, pos)) {
        const escaped = escapeControlChar(ch)
        current = current.slice(0, pos) + escaped + current.slice(pos + 1)
        continue
      }

      break
    }
  }

  // Return our best-effort repair even if the parser still complains; callers
  // can decide whether to try parsing it.
  return current
}

function escapeInternalQuotes(input: string): string {
  let result = ''
  let inString = false
  let escaped = false

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]

    if (escaped) {
      result += ch
      escaped = false
      continue
    }

    if (ch === '\\') {
      escaped = true
      result += ch
      continue
    }

    if (ch === '"') {
      if (!inString) {
        inString = true
        result += ch
        continue
      }

      // We are inside a string. Decide if this quote closes the string.
      // A closing quote is followed (after optional whitespace) by a JSON
      // structural character: ':' (key terminator), ',' (next item),
      // '}' or ']' (object/array close), or end of input.
      const nextNonSpace = findNextNonSpace(input, i + 1)
      if (
        nextNonSpace === ':' ||
        nextNonSpace === ',' ||
        nextNonSpace === '}' ||
        nextNonSpace === ']' ||
        nextNonSpace === '' // end of input
      ) {
        inString = false
        result += ch
      } else {
        // Looks like an internal unescaped quote.
        result += '\\"'
      }
      continue
    }

    result += ch
  }

  return result
}

function findNextNonSpace(input: string, start: number): string {
  for (let i = start; i < input.length; i++) {
    const ch = input[i]
    if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') {
      return ch
    }
  }
  return ''
}

function extractErrorPosition(err: unknown, input: string): number | null {
  if (!(err instanceof SyntaxError)) return null
  const message = err.message

  const posMatch = message.match(/position\s+(\d+)/i)
  if (posMatch) return Number(posMatch[1])

  const colMatch = message.match(/column\s+(\d+)/i)
  if (colMatch && !input.includes('\n')) {
    return Number(colMatch[1]) - 1
  }

  return null
}

function isUnescapedControlChar(input: string, pos: number): boolean {
  const ch = input[pos]
  if (ch === undefined) return false
  const code = ch.charCodeAt(0)
  if (code >= 0x20) return false
  if (code === 0x09 || code === 0x0a || code === 0x0d) {
    return input[pos - 1] !== '\\'
  }
  return false
}

function escapeControlChar(ch: string): string {
  const code = ch.charCodeAt(0)
  switch (code) {
    case 0x09: return '\\t'
    case 0x0a: return '\\n'
    case 0x0d: return '\\r'
    default: return '\\u' + code.toString(16).padStart(4, '0')
  }
}

let patched = false

/**
 * Install a global JSON.parse wrapper that attempts to repair malformed strings
 * only when normal parsing fails. If repair also fails, the original SyntaxError
 * is thrown so callers do not silently receive wrong data.
 */
export function installGlobalJsonRepair(): void {
  if (patched) return
  patched = true

  JSON.parse = function <T>(
    text: string,
    reviver?: (this: any, key: string, value: any) => any,
  ): T {
    try {
      return originalParse.call(JSON, text, reviver)
    } catch (originalErr) {
      if (typeof text !== 'string') throw originalErr
      try {
        const repaired = repairJsonString(text)
        return originalParse.call(JSON, repaired, reviver)
      } catch {
        throw originalErr
      }
    }
  } as typeof JSON.parse
}
