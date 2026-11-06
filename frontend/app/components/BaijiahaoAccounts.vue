<template>
  <dialog ref="dialog" class="accounts-dialog" aria-labelledby="accounts-title" @close="emit('close')" @click="closeOnBackdrop">
    <header><div><h2 id="accounts-title">百家号账号</h2><p>扫码添加账号，生产时选择上传到哪一个。</p></div><button class="btn btn-icon btn-ghost" aria-label="关闭账号管理" @click="dialog?.close()"><X :size="18" /></button></header>
    <div class="accounts-body">
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <section v-if="loginSession" class="login-panel" aria-live="polite">
        <strong>{{ activeAccount?.label || '账号登录' }}</strong>
        <img v-if="loginSession.status === 'waiting_scan' && loginSession.qrDataUrl" :src="loginSession.qrDataUrl" alt="百家号登录二维码，请使用百度 App 扫码" width="220" height="220" />
        <LoaderCircle v-else-if="loginPending" :size="28" class="spin" />
        <Check v-else-if="loginSession.status === 'ready'" :size="28" class="success" />
        <p>{{ loginSession.message }}</p>
        <small v-if="loginSession.status === 'waiting_scan'">使用百度 App 扫码，并在手机上确认登录。二维码仅供本次登录使用。</small>
        <button v-if="loginSession.status === 'failed'" class="btn btn-primary" :disabled="!!busy" @click="checkAccount(loginSession.accountName)">{{ busy === `check:${loginSession.accountName}` ? '检查中…' : '重新检查登录' }}</button>
        <button v-if="loginSession.status === 'failed'" class="btn" :disabled="!!busy" @click="startLogin(loginSession.accountName)">重新获取二维码</button>
        <button v-if="!loginPending" class="btn btn-ghost btn-sm" @click="loginSession = null">返回账号列表</button>
      </section>
      <template v-else>
        <p v-if="loading" class="empty" role="status">正在读取账号…</p>
        <p v-else-if="!accounts.length" class="empty">还没有百家号账号。添加后，即可在生产和上传时使用。</p>
        <ul v-else class="account-list">
          <li v-for="account in accounts" :key="account.accountName">
            <div class="account-info"><strong>{{ account.label }} <span v-if="account.isDefault" class="default-badge">默认</span></strong><span :class="{ success: account.status === 'ready' }">{{ statusLabel(account.status) }}</span><p v-if="account.status !== 'ready'">{{ account.message }}</p></div>
            <div class="account-actions"><button v-if="account.status !== 'ready'" class="btn btn-sm" :disabled="!!busy" @click="startLogin(account.accountName)">{{ account.status === 'logging_in' ? '查看二维码' : '扫码登录' }}</button><button v-if="account.status !== 'logging_in'" class="btn btn-ghost btn-sm" :disabled="!!busy" @click="checkAccount(account.accountName)">{{ busy === `check:${account.accountName}` ? '检查中…' : '检查登录' }}</button><button v-if="!account.isDefault && account.status === 'ready'" class="btn btn-ghost btn-sm" :disabled="!!busy" @click="setDefault(account.accountName)">设为默认</button></div>
          </li>
        </ul>
        <form class="add-form" @submit.prevent="addAccount"><label for="baijiahao-account-label">添加百家号账号</label><div><input id="baijiahao-account-label" v-model="label" required maxlength="40" autocomplete="off" placeholder="填写账号备注" :disabled="!!busy" /><button class="btn btn-primary" type="submit" :disabled="!!busy || !label.trim()"><LoaderCircle v-if="busy === 'add'" :size="14" class="spin" /><Plus v-else :size="14" />添加并扫码</button></div><small>备注仅用于区分账号。每次任务只上传到所选账号。</small></form>
      </template>
    </div>
    <footer>默认账号用于新任务，已开始的任务保持原账号。</footer>
  </dialog>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { Check, LoaderCircle, Plus, X } from 'lucide-vue-next'
import { api } from '~/composables/useApi'

const props = defineProps({ apiBase: { type: String, default: '/cba-video/accounts' } })
const emit = defineEmits(['close', 'updated'])
const dialog = ref(null)
const accounts = ref([])
const label = ref('')
const loading = ref(false)
const busy = ref('')
const error = ref('')
const loginSession = ref(null)
const activeAccount = computed(() => accounts.value.find(item => item.accountName === loginSession.value?.accountName))
const loginPending = computed(() => ['starting', 'waiting_scan'].includes(loginSession.value?.status))
let pollTimer
let polling = false
let disposed = false

function statusLabel(status) { return ({ ready: '已登录', login_required: '待扫码', logging_in: '等待登录', expired: '登录已失效', error: '需要处理' })[status] || '待检查' }
function stopPolling() { if (pollTimer) window.clearInterval(pollTimer); pollTimer = undefined }
async function loadAccounts() {
  loading.value = true
  try { const result = await api.get(props.apiBase); if (!disposed) { accounts.value = result.accounts; emit('updated', result) } }
  catch (err) { if (!disposed) error.value = err.message || '账号加载失败，请重新打开账号管理' }
  finally { loading.value = false }
}
async function pollLogin() {
  if (polling || !loginPending.value || disposed) return
  polling = true
  const id = loginSession.value.id
  try {
    const result = await api.get(`${props.apiBase}/logins/${encodeURIComponent(id)}`)
    if (disposed || loginSession.value?.id !== id) return
    loginSession.value = result; error.value = ''
    if (!loginPending.value) { stopPolling(); await loadAccounts() }
  } catch (err) {
    if (!disposed) { error.value = err.message || '登录状态读取失败'; if (err.status === 404) { stopPolling(); loginSession.value = { ...loginSession.value, status: 'failed', message: '登录会话已结束，请重新获取二维码。', qrDataUrl: undefined } } }
  } finally { polling = false }
}
async function startLogin(accountName) {
  if (busy.value) return
  busy.value = 'login'; error.value = ''; stopPolling()
  try {
    const result = await api.post(`${props.apiBase}/${encodeURIComponent(accountName)}/login`, {})
    if (disposed) return
    loginSession.value = result
    if (loginPending.value) pollTimer = window.setInterval(pollLogin, 2000)
    await loadAccounts()
  } catch (err) { error.value = err.message || '无法开始扫码登录' }
  finally { busy.value = '' }
}
async function addAccount() {
  if (busy.value || !label.value.trim()) return
  busy.value = 'add'; error.value = ''
  let account
  try { account = await api.post(props.apiBase, { label: label.value.trim() }); label.value = ''; await loadAccounts() }
  catch (err) { error.value = err.message || '添加失败，请重试' }
  finally { busy.value = '' }
  if (account && !disposed) await startLogin(account.accountName)
}
async function setDefault(accountName) {
  busy.value = 'default'; error.value = ''
  try { await api.post(`${props.apiBase}/${encodeURIComponent(accountName)}/default`, {}); await loadAccounts() }
  catch (err) { error.value = err.message || '设置默认账号失败' }
  finally { busy.value = '' }
}
async function checkAccount(accountName) {
  if (busy.value) return
  const sessionId = loginSession.value?.accountName === accountName ? loginSession.value.id : null
  busy.value = `check:${accountName}`; error.value = ''
  try {
    const account = await api.post(`${props.apiBase}/${encodeURIComponent(accountName)}/check`, {})
    if (disposed) return
    if (account.accountName !== accountName) throw new Error('登录检查返回的账号不一致，请重新检查')
    if (sessionId && loginSession.value?.id === sessionId && loginSession.value.accountName === accountName) {
      stopPolling()
      loginSession.value = { ...loginSession.value, status: account.status === 'ready' ? 'ready' : 'failed',
        message: account.message || (account.status === 'ready' ? '账号已登录' : '登录尚未完成，请检查手机确认或重新扫码'), qrDataUrl: undefined }
    }
    await loadAccounts()
  }
  catch (err) { if (!disposed) error.value = err.message || '登录检查失败' }
  finally { busy.value = '' }
}
function closeOnBackdrop(event) {
  if (event.target !== dialog.value) return
  const rect = dialog.value.getBoundingClientRect()
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.value.close()
}
onMounted(async () => { await nextTick(); if (!disposed) { dialog.value?.showModal(); await loadAccounts() } })
onBeforeUnmount(() => { disposed = true; stopPolling() })
</script>

<style scoped>
.accounts-dialog { box-sizing: border-box; margin: auto; width: min(580px, calc(100vw - 32px)); max-height: 88vh; padding: 0; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-0); color: var(--text-1); font: 13px/1.5 -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif; box-shadow: 0 16px 60px #0003; }
.accounts-dialog::backdrop { background: #11182766; }.accounts-dialog header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding: 22px 24px 18px; border-bottom: 1px solid var(--border); }.accounts-dialog h2 { font-size: 18px; margin: 0; }.accounts-dialog header p { margin: 5px 0 0; color: var(--text-3); }.accounts-body { padding: 20px 24px; }.accounts-dialog footer { padding: 14px 24px; color: var(--text-3); font-size: 12px; border-top: 1px solid var(--border); }.empty { padding: 14px 0; color: var(--text-3); }.account-list { list-style: none; padding: 0; margin: 0 0 20px; }.account-list li { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 15px 0; border-bottom: 1px solid var(--border); }.account-info { min-width: 0; display: grid; gap: 5px; }.account-info strong { overflow-wrap: anywhere; }.account-info > span { font-size: 12px; color: var(--text-3); }.account-info p { margin: 0; font-size: 12px; color: var(--text-3); }.account-actions { display: flex; flex-shrink: 0; gap: 5px; }.default-badge { display: inline-block; padding: 1px 6px; margin-left: 6px; border-radius: 4px; font-size: 11px; font-weight: 500; background: var(--bg-2); color: var(--text-2); }.add-form { display: grid; gap: 9px; }.add-form > label { font-weight: 600; }.add-form > div { display: flex; gap: 8px; }.add-form input { min-width: 0; flex: 1; padding: 9px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-0); color: var(--text-1); font: inherit; }.add-form small, .login-panel small { color: var(--text-3); }.login-panel { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 8px 8px 18px; text-align: center; }.login-panel img { object-fit: contain; padding: 10px; background: white; border: 1px solid var(--border); border-radius: 8px; }.login-panel p { margin: 0; }.success, .account-info > .success { color: #15803d; }.error { padding: 10px; background: #fff1f2; color: #b91c1c; border-radius: 6px; }.spin { animation: account-spin 1s linear infinite; }@keyframes account-spin { to { transform: rotate(360deg); } }.accounts-dialog :is(button,input):focus-visible { outline: 2px solid var(--info); outline-offset: 3px; }@media(max-width: 540px) { .account-list li { align-items: flex-start; flex-direction: column; gap: 10px; }.add-form > div { flex-direction: column; }.accounts-body { padding: 18px; } }
</style>
