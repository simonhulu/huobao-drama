function configuredOrigin(value) {
  if (value === undefined || value.trim() === '') return
  let url
  try { url = new URL(value.trim()) } catch {}
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.hostname.includes('*') || ![url.origin, `${url.origin}/`].includes(value.trim())) {
    throw new Error('WORKSPACE_PUBLIC_ORIGIN must be a clean HTTP(S) origin without credentials, paths, queries, fragments or wildcards')
  }
  return url
}

export function createWorkspaceApiProxy(target, publicOrigin) {
  const options = { target, changeOrigin: true }
  const allowed = configuredOrigin(publicOrigin)
  if (!allowed) return options
  return {
    ...options,
    configure(proxy) {
      proxy.on('proxyReq', (outgoing, incoming) => {
        const site = incoming.headers['sec-fetch-site']
        if (incoming.headers.origin === allowed.origin && incoming.headers.host === allowed.host
          && (site === undefined || site === 'same-origin' || site === 'none')) {
          outgoing.setHeader('Origin', 'http://127.0.0.1:3013')
        }
      })
    },
  }
}
