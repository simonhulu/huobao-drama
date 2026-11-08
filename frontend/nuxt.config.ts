import { createWorkspaceApiProxy } from './config/workspace-proxy.mjs'

const apiProxyTarget = process.env.API_PROXY_TARGET || 'http://127.0.0.1:5679'
const apiProxy = (target: string) => createWorkspaceApiProxy(target, process.env.WORKSPACE_PUBLIC_ORIGIN)

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
        '^/api/v1/nba-video(?:/|\\?|$)': apiProxy(process.env.NBA_API_TARGET || 'http://127.0.0.1:5684'),
        '^/api/v1/history-scripts/jobs/[0-9]+/outcomes(?:\\?|$)': apiProxy(process.env.HISTORY_BATCH_API_TARGET || 'http://127.0.0.1:5682'),
        '^/api/v1/storage(?:/|\\?|$)': apiProxy(process.env.STORAGE_API_TARGET || 'http://127.0.0.1:5681'),
        ...(process.env.MYSTERY_API_TARGET ? {
          '^/api/v1/mystery-stories(?:/|\\?|$)': apiProxy(process.env.MYSTERY_API_TARGET),
        } : {}),
        '^/api/v1/science-pop/workflow(?:/|\\?|$)': apiProxy(process.env.SCIENCE_API_TARGET || 'http://127.0.0.1:5683'),
        // Optional read-only list rollout while the main backend is executing jobs.
        ...(process.env.HISTORY_LIBRARY_API_TARGET ? {
          '^/api/v1/history-scripts(?:\\?|$)': apiProxy(process.env.HISTORY_LIBRARY_API_TARGET),
        } : {}),
        // Optional voice-library rollout without restarting active production.
        ...(process.env.VOICE_LIBRARY_API_TARGET ? {
          '^/api/v1/ai-voices/(?:available|default|preview)(?:\\?|$)': apiProxy(process.env.VOICE_LIBRARY_API_TARGET),
        } : {}),
        '/api': apiProxy(apiProxyTarget),
        '/static': { target: apiProxyTarget, changeOrigin: true },
        '/sfx': { target: apiProxyTarget, changeOrigin: true },
      },
    },
  },
  compatibilityDate: '2025-05-15',
})
