import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { createServer } from 'vite'
import { createWorkspaceApiProxy } from '../config/workspace-proxy.mjs'

const target = 'http://127.0.0.1:5679'
const publicOrigin = 'http://192.168.0.107:3013'
const headers = (extra = {}) => ({ origin: publicOrigin, host: '192.168.0.107:3013', ...extra })
function forwarded(incoming, origin = publicOrigin) {
  const proxy = new EventEmitter(), result = { ...incoming }
  createWorkspaceApiProxy(target, origin).configure?.(proxy)
  proxy.emit('proxyReq', { setHeader(name, value) { result[name.toLowerCase()] = value } }, { headers: incoming })
  return result
}

test('an absent or blank public origin preserves the existing proxy configuration and localhost requests', () => {
  for (const origin of [undefined, '', '  ']) {
    assert.deepEqual(createWorkspaceApiProxy(target, origin), { target, changeOrigin: true })
    const local = headers({ origin: 'http://localhost:3013', host: 'localhost:3013' })
    assert.deepEqual(forwarded(local, origin), local)
  }
})

test('public origin configuration rejects credentials, non-origin URLs and wildcards', () => {
  for (const origin of ['null', '*', 'ftp://192.168.0.107:3013', 'http://user:pass@192.168.0.107:3013',
    `${publicOrigin}/api`, `${publicOrigin}?`, `${publicOrigin}?a=1`, `${publicOrigin}#`, `${publicOrigin}#a`,
    'http://*.example.com:3013', 'http://192.168.0.107:3013.evil.test']) {
    assert.throws(() => createWorkspaceApiProxy(target, origin), /WORKSPACE_PUBLIC_ORIGIN/)
  }
  assert.equal(typeof createWorkspaceApiProxy(target, `${publicOrigin}/`).configure, 'function')
  assert.equal(typeof createWorkspaceApiProxy(target, 'https://workspace.example.com').configure, 'function')
})

test('only the configured same-origin authority is normalized and incoming headers are preserved', () => {
  for (const site of [undefined, 'same-origin', 'none']) {
    const incoming = headers(site ? { 'sec-fetch-site': site } : {})
    const original = { ...incoming }
    assert.equal(forwarded(incoming).origin, 'http://127.0.0.1:3013')
    assert.deepEqual(incoming, original)
  }
})

test('foreign, missing, null and ambiguous origins, spoofed hosts and cross-site requests are never rewritten', () => {
  for (const incoming of [
    headers({ origin: 'https://attacker.example' }), headers({ origin: 'null' }), headers({ origin: undefined }),
    headers({ origin: [publicOrigin] }), headers({ origin: `${publicOrigin}/` }),
    headers({ origin: 'http://localhost:3013', host: 'localhost:3013' }),
    headers({ host: '127.0.0.1:3013' }), headers({ host: '192.168.0.107' }), headers({ host: ['192.168.0.107:3013'] }),
    ...['cross-site', 'same-site', 'same-origin, cross-site'].map(site => headers({ 'sec-fetch-site': site })),
  ]) assert.deepEqual(forwarded(incoming), incoming)
})

test('the actual Vite HTTP proxy normalizes trusted LAN requests and preserves rejected origins', async t => {
  const backend = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ origin: request.headers.origin, host: request.headers.host }))
  })
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => backend.close(resolve)))
  const backendTarget = `http://127.0.0.1:${backend.address().port}`
  const vite = await createServer({
    configFile: false, logLevel: 'silent', appType: 'custom',
    server: { middlewareMode: true, hmr: false, proxy: { '/api': createWorkspaceApiProxy(backendTarget, publicOrigin) } },
    optimizeDeps: { noDiscovery: true, include: [] },
  })
  t.after(() => vite.close())
  const frontend = http.createServer(vite.middlewares)
  await new Promise(resolve => frontend.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => frontend.close(resolve)))
  async function request(incoming) {
    return new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: frontend.address().port, path: '/api/check', headers: incoming, agent: false }, response => {
        let body = ''
        response.setEncoding('utf8').on('data', chunk => { body += chunk }).on('end', () => {
          try { assert.equal(response.statusCode, 200); resolve(JSON.parse(body)) } catch (error) { reject(error) }
        })
      })
      request.on('error', reject).end()
    })
  }
  for (const site of [undefined, 'same-origin', 'none']) {
    assert.deepEqual(await request(headers(site ? { 'sec-fetch-site': site } : {})), {
      origin: 'http://127.0.0.1:3013', host: `127.0.0.1:${backend.address().port}`,
    })
  }
  for (const incoming of [headers({ 'sec-fetch-site': 'cross-site' }), headers({ 'sec-fetch-site': 'same-site' }),
    headers({ host: '127.0.0.1:3013' }), headers({ origin: 'https://attacker.example' })]) {
    assert.equal((await request(incoming)).origin, incoming.origin)
  }
})
