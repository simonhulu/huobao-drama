<template>
  <TaskCenter
    v-model:open="open"
    :tasks="tasks"
    :loading="loading"
    :error="error"
    :last-loaded-at="lastLoadedAt"
    :worker-health="workerHealth"
    :is-worker-healthy="isWorkerHealthy"
    :telemetry-by-task-id="telemetryByTaskId"
    @refresh="loadTasks"
    @cancel="cancelFromTaskCenter"
    @retry="retryTaskWithToast"
  />
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useTasks } from '~/composables/useTasks'
import TaskCenter from '~/components/TaskCenter.vue'

const open = ref(false)

const {
  tasks,
  loading,
  error,
  lastLoadedAt,
  workerHealth,
  isWorkerHealthy,
  telemetryByTaskId,
  loadTasks,
  startUpdates,
  cancelTaskWithToast,
  retryTaskWithToast,
} = useTasks({ pollMs: 3000, activeOnly: true })

function cancelFromTaskCenter(payload: {
  task: { id: number }
  reason?: string
  confirmation?: string
  actor?: string
  controlToken?: string
}, complete?: (result: { ok: boolean; error?: string }) => void) {
  const protectedPayload = payload.reason || payload.confirmation || payload.actor || payload.controlToken
    ? {
        reason: payload.reason,
        confirmation: payload.confirmation,
        actor: payload.actor,
        controlToken: payload.controlToken,
      }
    : undefined
  void cancelTaskWithToast(payload.task.id, protectedPayload)
    .then(result => complete?.(result))
    .catch((err: any) => complete?.({ ok: false, error: err?.message || '取消任务失败' }))
}

onMounted(() => {
  loadTasks()
  startUpdates()
})
</script>
