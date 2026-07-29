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
  /**
   * Task events are best-effort observation. A disconnected SSE consumer must
   * never turn a committed task or delivery mutation into an application error.
   */
  private notify(event: TaskStreamEvent): void {
    for (const listener of this.rawListeners('task')) {
      try {
        listener.call(this, event)
      } catch (error) {
        // Keep dispatching to healthy subscribers and leave durable task state intact.
        try {
          console.error('[tasks] task event listener failed:', error)
        } catch {
          // Notification diagnostics are also best effort.
        }
      }
    }
  }

  notifyTaskChanged(task: CreationTask, reason?: string): void {
    this.notify({ type: 'task.changed', task, reason } satisfies TaskChangedEvent)
  }

  notifyTaskEventAdded(taskId: number, event: CreationTaskEvent): void {
    this.notify({ type: 'task.event_added', taskId, event } satisfies TaskEventAddedEvent)
  }
}

export const taskEventBus = new TaskEventBus()
