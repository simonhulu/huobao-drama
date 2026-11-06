<template>
  <HuashengAccounts scope="science" @close="emit('close')" @updated="emit('updated', $event)" />
</template>

<script setup>
import HuashengAccounts from '~/components/HuashengAccounts.vue'

const emit = defineEmits(['close', 'updated'])
</script>
