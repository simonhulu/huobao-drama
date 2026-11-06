const apiProxyTarget = process.env.API_PROXY_TARGET || 'http://127.0.0.1:5679'

export default defineNuxtConfig({
  srcDir: 'app/',
  ssr: false,
  devtools: { enabled: false },
  experimental: {
    appManifest: false,
  },
  app: {
    head: {
      title: '火宝短剧',
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }],
      link: [
        { rel: 'icon', type: 'image/png', href: '/favicon.png' },
        { rel: 'shortcut icon', type: 'image/png', href: '/favicon.png' },
      ],
    },
  },
  vite: {
    server: {
      proxy: {
        '^/api/v1/nba-video(?:/|\\?|$)': { target: process.env.NBA_API_TARGET || 'http://127.0.0.1:5684', changeOrigin: true },
        '^/api/v1/history-scripts/jobs/[0-9]+/outcomes(?:\\?|$)': { target: process.env.HISTORY_BATCH_API_TARGET || 'http://127.0.0.1:5682', changeOrigin: true },
        '^/api/v1/storage(?:/|\\?|$)': { target: process.env.STORAGE_API_TARGET || 'http://127.0.0.1:5681', changeOrigin: true },
        ...(process.env.MYSTERY_API_TARGET ? {
          '^/api/v1/mystery-stories(?:/|\\?|$)': { target: process.env.MYSTERY_API_TARGET, changeOrigin: true },
        } : {}),
        '^/api/v1/science-pop/workflow(?:/|\\?|$)': { target: process.env.SCIENCE_API_TARGET || 'http://127.0.0.1:5683', changeOrigin: true },
        // Optional read-only list rollout while the main backend is executing jobs.
        ...(process.env.HISTORY_LIBRARY_API_TARGET ? {
          '^/api/v1/history-scripts(?:\\?|$)': { target: process.env.HISTORY_LIBRARY_API_TARGET, changeOrigin: true },
        } : {}),
        // Optional voice-library rollout without restarting active production.
        ...(process.env.VOICE_LIBRARY_API_TARGET ? {
          '^/api/v1/ai-voices/(?:available|default|preview)(?:\\?|$)': { target: process.env.VOICE_LIBRARY_API_TARGET, changeOrigin: true },
        } : {}),
        '/api': { target: apiProxyTarget, changeOrigin: true },
        '/static': { target: apiProxyTarget, changeOrigin: true },
        '/sfx': { target: apiProxyTarget, changeOrigin: true },
      },
    },
  },
  compatibilityDate: '2025-05-15',
})
