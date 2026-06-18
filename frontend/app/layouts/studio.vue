<template>
  <div class="studio-fullscreen">
    <slot />
    <GlobalTaskCenter />
  </div>
</template>

<script setup>
import GlobalTaskCenter from '~/components/GlobalTaskCenter.vue'
</script>

<style scoped>
.studio-fullscreen { height: 100vh; display: flex; flex-direction: column; overflow: hidden; background: var(--bg-base); }
</style>
