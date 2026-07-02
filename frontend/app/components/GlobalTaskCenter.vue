<template>
  <TaskCenter
    v-model:open="open"
    :tasks="tasks"
    :loading="loading"
    :error="error"
    :last-loaded-at="lastLoadedAt"
    :worker-health="workerHealth"
    :is-worker-healthy="isWorkerHealthy"
    @refresh="loadTasks"
    @cancel="cancelTaskWithToast"
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
  loadTasks,
  startUpdates,
  cancelTaskWithToast,
  retryTaskWithToast,
} = useTasks({ pollMs: 3000 })

onMounted(() => {
  loadTasks()
  startUpdates()
})
</script>
