import type { TaskHandler } from './types.js'

const handlers = new Map<string, TaskHandler>()

export function registerTaskHandler(type: string, handler: TaskHandler) {
  handlers.set(type, handler)
}

export function getTaskHandler(type: string) {
  return handlers.get(type) || null
}

export function listRegisteredTaskTypes() {
  return [...handlers.keys()]
}

export function clearTaskHandlers() {
  handlers.clear()
}
