import test from 'node:test'
import assert from 'node:assert/strict'
import { ensureSocialUploadBrowser, type SocialUploadBrowserDependencies, type SocialUploadBrowserOptions } from './social-upload-browser.js'

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const options: SocialUploadBrowserOptions = {
  endpoint: 'http://127.0.0.1:9222', projectRoot: '/project with spaces',
  profileDir: '/project with spaces/data/wechat-channels-profile',
  starter: 'start-wechat-channels-cdp-chrome.mjs', portVar: 'WECHAT_CHANNELS_CDP_PORT',
}
const command = `${chrome} --remote-debugging-port=9222 --user-data-dir=${options.profileDir} --no-first-run https://channels.weixin.qq.com/platform`
const page = { type: 'page', id: 'page-1' }

function fixture() {
  const state = {
    online: true, targets: [] as unknown[], listeners: '4321\n', command, started: false, terminated: false, exited: false,
    exitAfter: 2, exitChecks: 0, clock: 0, startupTargets: [page] as unknown[], starterError: undefined as Error | undefined,
    reads: 0, beforeRead: undefined as ((count: number) => void) | undefined,
    realProfile: options.profileDir, busyAfterExit: false,
  }
  const signals: Array<[number, 'SIGTERM' | 0]> = []
  const starts: Array<{ script: string; cwd: string; env: NodeJS.ProcessEnv }> = []
  const commands: Array<{ file: string; args: string[] }> = []
  const deps: SocialUploadBrowserDependencies = {
    async readJson(url, timeoutMs) {
      assert.equal(url, 'http://127.0.0.1:9222/json/list')
      assert.ok(timeoutMs > 0 && timeoutMs <= 1500)
      state.reads++
      state.beforeRead?.(state.reads)
      if (state.started) return state.startupTargets
      if (!state.online) throw new Error('connect ECONNREFUSED 127.0.0.1:9222')
      return state.targets
    },
    async exec(file, args, timeoutMs) {
      assert.ok(timeoutMs > 0 && timeoutMs <= 2000)
      commands.push({ file, args })
      if (file === '/usr/sbin/lsof') {
        assert.ok(args.includes('-iTCP:9222'))
        assert.ok(args.includes('-sTCP:LISTEN'))
        return state.exited ? state.busyAfterExit ? '9999\n' : '' : state.listeners
      }
      assert.equal(file, '/bin/ps')
      assert.deepEqual(args, ['-ww', '-p', '4321', '-o', 'command='])
      return state.command
    },
    start(script, startOptions) {
      starts.push({ script, ...startOptions })
      state.started = true
      return { error: state.starterError }
    },
    signal(pid, signal) {
      signals.push([pid, signal])
      assert.equal(pid, 4321)
      if (signal === 'SIGTERM') { state.terminated = true; return }
      assert.equal(state.terminated, true)
      if (++state.exitChecks >= state.exitAfter) {
        state.exited = true
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
      }
    },
    async realpath(file) { return file === options.profileDir ? state.realProfile : file },
    now: () => state.clock,
    async sleep(ms) { assert.ok(ms > 0 && ms <= 250); state.clock += ms },
  }
  return { state, deps, signals, starts, commands, run: () => ensureSocialUploadBrowser(options, deps) }
}

test('a browser with a page returns without inspecting or disturbing its process', async () => {
  const h = fixture()
  h.state.targets = [page, { type: 'service_worker' }]
  await h.run()
  assert.equal(h.state.reads, 1)
  assert.deepEqual(h.commands, [])
  assert.deepEqual(h.signals, [])
  assert.deepEqual(h.starts, [])
})

test('an absent listener starts the supplied script once and waits for a page', async () => {
  const h = fixture()
  h.state.online = false
  h.state.listeners = ''
  await h.run()
  assert.equal(h.starts.length, 1)
  assert.equal(h.starts[0].script, '/project with spaces/backend/scripts/start-wechat-channels-cdp-chrome.mjs')
  assert.equal(h.starts[0].cwd, '/project with spaces/backend')
  assert.equal(h.starts[0].env.WECHAT_CHANNELS_CDP_PORT, '9222')
  assert.deepEqual(h.signals, [])
})

test('empty targets with exact dedicated Chrome ownership get one TERM, exit verification, then one start', async () => {
  const h = fixture()
  await h.run()
  assert.deepEqual(h.signals, [[4321, 'SIGTERM'], [4321, 0], [4321, 0]])
  assert.equal(h.state.exited, true)
  assert.equal(h.starts.length, 1)
  assert.equal(h.commands.filter(call => call.file === '/bin/ps').length, 2, 'Ownership is checked again before TERM')
  assert.equal(h.state.reads, 3, 'Targets are rechecked immediately before TERM, then after starting')
})

for (const type of ['service_worker', 'worker', 'browser']) {
  test(`a nonempty ${type} target list is never terminated or restarted`, async () => {
    const h = fixture()
    h.state.targets = [{ type }]
    await assert.rejects(h.run(), /已有.*target/)
    assert.deepEqual(h.signals, [])
    assert.deepEqual(h.starts, [])
  })
}

for (const unsafe of [
  command.replace(chrome, `${chrome} Helper`),
  command.replace(chrome, '/Applications/Firefox.app/Contents/MacOS/firefox'),
  command.replace(options.profileDir, '/other-project/data/wechat-channels-profile'),
  command.replace(options.profileDir, `${options.profileDir}-other`),
  command.replace('port=9222', 'port=92220'),
  `${command} --user-data-dir=/other-profile`,
  `${command} --type=renderer`,
]) {
  test(`refuses a process command without exact ownership: ${unsafe}`, async () => {
    const h = fixture()
    h.state.command = unsafe
    await assert.rejects(h.run(), /专用 Chrome/)
    assert.deepEqual(h.signals, [])
    assert.deepEqual(h.starts, [])
  })
}

for (const listeners of ['', '4321\n9999\n', 'not-a-pid\n']) {
  test(`empty CDP targets without a unique valid listener PID are left untouched: ${JSON.stringify(listeners)}`, async () => {
    const h = fixture()
    h.state.listeners = listeners
    await assert.rejects(h.run(), /监听.*PID/)
    assert.deepEqual(h.signals, [])
    assert.deepEqual(h.starts, [])
  })
}

test('a page appearing during ownership inspection prevents termination', async () => {
  const h = fixture()
  h.state.beforeRead = count => { if (count === 2) h.state.targets = [page] }
  await h.run()
  assert.deepEqual(h.signals, [])
  assert.deepEqual(h.starts, [])
})

test('a profile symlink outside this project is not eligible for termination', async () => {
  const h = fixture()
  h.state.realProfile = '/other-project/data/wechat-channels-profile'
  await assert.rejects(h.run(), /profile.*本项目/)
  assert.deepEqual(h.signals, [])
  assert.deepEqual(h.starts, [])
})

test('an unresponsive occupied port is not treated as an absent browser', async () => {
  const h = fixture()
  h.state.online = false
  await assert.rejects(h.run(), /CDP.*ECONNREFUSED/)
  assert.deepEqual(h.signals, [])
  assert.deepEqual(h.starts, [])
})

test('TERM exit timeout never escalates to KILL or starts a competing Chrome', async () => {
  const h = fixture()
  h.state.exitAfter = Infinity
  await assert.rejects(h.run(), /退出超时.*4321/)
  assert.equal(h.state.clock, 5000)
  assert.deepEqual(h.signals.filter(([, signal]) => signal !== 0), [[4321, 'SIGTERM']])
  assert.deepEqual(h.starts, [])
})

test('port reuse after the old process exits prevents a replacement start', async () => {
  const h = fixture()
  h.state.busyAfterExit = true
  await assert.rejects(h.run(), /端口.*占用/)
  assert.deepEqual(h.starts, [])
})

test('a starter reporting SingletonLock exit 21 produces a concrete failure without retry', async () => {
  const h = fixture()
  h.state.online = false
  h.state.listeners = ''
  h.state.starterError = new Error('Chrome 启动脚本退出（21）')
  await assert.rejects(h.run(), /21/)
  assert.equal(h.starts.length, 1)
  assert.deepEqual(h.signals, [])
})

test('a started browser remaining empty times out without another restart', async () => {
  const h = fixture()
  h.state.online = false
  h.state.listeners = ''
  h.state.startupTargets = []
  await assert.rejects(h.run(), /启动超时.*page/)
  assert.equal(h.state.clock, 10_000)
  assert.equal(h.starts.length, 1)
  assert.deepEqual(h.signals, [])
})
