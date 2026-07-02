import { EventEmitter } from 'node:events'
import type { CreationTask, CreationTaskEvent } from './types.js'

export interface TaskChangedEvent {
  type: 'task.changed'
  task: CreationTask
  reason?: string
}

export interface TaskEventAddedEvent {
  type: 'task.event_added'
  taskId: number
  event: CreationTaskEvent
}

export type TaskStreamEvent = TaskChangedEvent | TaskEventAddedEvent

class TaskEventBus extends EventEmitter {
  notifyTaskChanged(task: CreationTask, reason?: string): void {
    this.emit('task', { type: 'task.changed', task, reason } satisfies TaskChangedEvent)
  }

  notifyTaskEventAdded(taskId: number, event: CreationTaskEvent): void {
    this.emit('task', { type: 'task.event_added', taskId, event } satisfies TaskEventAddedEvent)
  }
}

export const taskEventBus = new TaskEventBus()
