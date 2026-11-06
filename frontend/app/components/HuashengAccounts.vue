<template>
  <dialog ref="dialog" class="accounts-dialog" :aria-labelledby="titleId" @close="emit('close')" @click="closeOnBackdrop">
    <header>
      <h2 :id="titleId">{{ title }}</h2>
      <div class="dialog-actions">
        <button class="btn btn-icon btn-ghost" type="button" aria-label="刷新账号" title="刷新账号" :disabled="loading || !!busy" @click="loadAccounts"><RefreshCw :size="16" :class="{ spin: loading }" /></button>
        <button class="btn btn-icon btn-ghost" type="button" :aria-label="`关闭${title}管理`" :title="`关闭${title}管理`" @click="dialog?.close()"><X :size="18" /></button>
      </div>
    </header>
    <div class="accounts-body" :aria-busy="loading">
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="notice" class="notice" role="status">{{ notice }}</p>
      <p v-if="loading && !accounts.length" class="empty" role="status">正在读取账号...</p>
      <p v-else-if="!accounts.length && !error" class="empty">暂无{{ scopeLabel }}花生账号</p>
      <ul v-if="accounts.length" class="account-list">
        <li v-for="account in accounts" :key="account.accountName">
          <div class="account-info">
            <strong>{{ account.label }} <span v-if="scope !== 'history' && account.isDefault" class="default-badge">默认</span></strong>
            <span class="account-status" :class="accountState(account).tone" role="status"><CircleCheck v-if="accountState(account).tone === 'success'" :size="14" /><CircleAlert v-else :size="14" />{{ accountState(account).label }}</span>
            <p v-if="accountMessage(account)">{{ accountMessage(account) }}</p>
            <dl class="identity-details">
              <dt>绑定身份</dt><dd><template v-if="account.identity"><span>{{ account.identity.displayName || '未命名用户' }}</span><code>{{ account.identity.uid }}</code></template><span v-else class="muted">尚未核验</span></dd>
              <dt>当前登录</dt><dd><template v-if="account.observedIdentity"><span>{{ account.observedIdentity.displayName || '未命名用户' }}</span><code>{{ account.observedIdentity.uid }}</code></template><span v-else class="muted">未读取</span></dd>
              <dt>最近检查</dt><dd><time v-if="account.checkedAt" :datetime="account.checkedAt">{{ formatTime(account.checkedAt) }}</time><span v-else class="muted">尚未检查</span></dd>
            </dl>
          </div>
          <div class="account-actions">
            <button class="btn btn-sm" type="button" :disabled="loading || !!busy" :aria-busy="busy === `login:${account.accountName}`" @click="accountAction(account.accountName, 'login')"><LoaderCircle v-if="busy === `login:${account.accountName}`" :size="14" class="spin" /><LogIn v-else :size="14" />登录窗口</button>
            <button class="btn btn-ghost btn-sm" type="button" :disabled="loading || !!busy" :aria-busy="busy === `check:${account.accountName}`" @click="accountAction(account.accountName, 'check')"><LoaderCircle v-if="busy === `check:${account.accountName}`" :size="14" class="spin" /><ShieldCheck v-else :size="14" />检查账号</button>
            <button v-if="scope !== 'history' && !account.isDefault" class="btn btn-ghost btn-sm" type="button" :disabled="loading || !!busy" @click="accountAction(account.accountName, 'default')"><Check :size="14" />设为默认</button>
          </div>
        </li>
      </ul>
      <form v-if="scope !== 'history'" class="add-form" @submit.prevent="addAccount">
        <label :for="labelId">添加花生账号</label>
        <div><input :id="labelId" v-model="label" required maxlength="40" autocomplete="off" placeholder="账号备注" :disabled="loading || !!busy" /><button class="btn btn-primary" type="submit" :disabled="loading || !!busy || !label.trim()"><LoaderCircle v-if="busy === 'add'" :size="14" class="spin" /><Plus v-else :size="14" />添加账号</button></div>
      </form>
    </div>
    <footer v-if="scope !== 'history'">默认账号用于新任务，已有任务保留原账号。</footer>
  </dialog>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import { Check, CircleAlert, CircleCheck, LoaderCircle, LogIn, Plus, RefreshCw, ShieldCheck, X } from 'lucide-vue-next'
import { api } from '~/composables/useApi'

const props = defineProps({ scope: { type: String, required: true, validator: value => ['history', 'science', 'mystery'].includes(value) } })
const emit = defineEmits(['close', 'updated'])
const base = computed(() => ({ history: '/history-scripts/huasheng/accounts', science: '/science-pop/workflow/accounts/huasheng', mystery: '/mystery-stories/accounts/huasheng' })[props.scope])
const scopeLabel = computed(() => ({ history: '历史', science: '科普', mystery: '奇闻故事' })[props.scope])
const title = computed(() => `${scopeLabel.value}花生账号`)
const titleId = `huasheng-accounts-${useId()}`
const labelId = `huasheng-label-${useId()}`
const dialog = ref(null)
const accounts = ref([])
const label = ref('')
const loading = ref(false)
const busy = ref('')
const error = ref('')
const notice = ref('')
const unconfirmed = ref([])
let disposed = false

function verifiedIdentity(account) {
  return account.identityStatus === 'verified' && account.identity?.uid && account.identity.uid === account.observedIdentity?.uid
}
function accountMessage(account) {
  if (unconfirmed.value.includes(account.accountName)) return ''
  if (account.status === 'ready' && !verifiedIdentity(account) && !['mismatch', 'conflict', 'unavailable'].includes(account.identityStatus)) return ''
  return account.message
}
function accountState(account) {
  if (unconfirmed.value.includes(account.accountName)) return { label: '检查未完成', tone: 'warning' }
  if (account.identityStatus === 'mismatch') return { label: '登录账号不匹配', tone: 'danger' }
  if (account.identityStatus === 'conflict') return { label: '账号重复', tone: 'danger' }
  if (account.identityStatus === 'unavailable') return { label: '身份核验失败', tone: 'warning' }
  if (account.status === 'ready') {
    return verifiedIdentity(account) ? { label: '已核验，可制作', tone: 'success' } : { label: '待核验', tone: 'warning' }
  }
  return { label: ({ login_required: '待登录', logging_in: '等待登录', expired: '登录已失效', error: '需要处理' })[account.status] || '待检查', tone: 'warning' }
}
function formatTime(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '检查时间未知' : date.toLocaleString('zh-CN', { hour12: false })
}
async function loadAccounts() {
  if (loading.value || disposed) return
  loading.value = true
  error.value = ''
  try {
    const result = await api.get(base.value)
    if (!Array.isArray(result?.accounts)) throw new Error('账号列表响应不完整，请重试')
    if (!disposed) { accounts.value = result.accounts; emit('updated', result) }
  } catch (err) {
    if (!disposed) error.value = err.message || '账号加载失败，请重试'
  } finally { if (!disposed) loading.value = false }
}
async function addAccount() {
  if (props.scope === 'history' || loading.value || busy.value || !label.value.trim()) return
  busy.value = 'add'; error.value = ''; notice.value = ''
  try {
    await api.post(base.value, { label: label.value.trim() })
    if (disposed) return
    label.value = ''; notice.value = '账号已添加。'; await loadAccounts()
  } catch (err) { if (!disposed) error.value = err.message || '添加失败，请重试' }
  finally { if (!disposed) busy.value = '' }
}
async function accountAction(accountName, action) {
  if (loading.value || busy.value || props.scope === 'history' && action === 'default') return
  busy.value = `${action}:${accountName}`; error.value = ''; notice.value = ''
  try {
    const result = await api.post(`${base.value}/${encodeURIComponent(accountName)}/${action}`, {})
    if (disposed) return
    if (Array.isArray(result?.accounts)) accounts.value = result.accounts
    else if (result?.accountName === accountName && typeof result.status === 'string') {
      accounts.value = accounts.value.map(account => account.accountName === accountName ? result : account)
    } else throw new Error('账号操作响应不完整，请刷新账号核对')
    unconfirmed.value = unconfirmed.value.filter(name => name !== accountName)
    emit('updated', { scope: props.scope, accounts: accounts.value, defaultAccountName: accounts.value.find(account => account.isDefault)?.accountName || null })
    notice.value = action === 'default' ? '默认账号已更新。' : result.message || '账号状态已更新。'
    await loadAccounts()
  } catch (err) {
    if (!disposed) {
      if (action !== 'default') unconfirmed.value = [...new Set([...unconfirmed.value, accountName])]
      error.value = err.message || '账号操作失败，请重试'
    }
  } finally { if (!disposed) busy.value = '' }
}
function closeOnBackdrop(event) {
  if (event.target !== dialog.value) return
  const rect = dialog.value.getBoundingClientRect()
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.value.close()
}
onMounted(async () => { await nextTick(); if (!disposed) { dialog.value?.showModal(); await loadAccounts() } })
onBeforeUnmount(() => { disposed = true })
</script>

<style scoped>
.accounts-dialog { box-sizing: border-box; margin: auto; width: min(700px, calc(100vw - 32px)); max-height: 88vh; max-height: 88dvh; padding: 0; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-0); color: var(--text-1); font: 13px/1.5 -apple-system, BlinkMacSystemFont, 'PingFang SC', sans-serif; letter-spacing: 0; box-shadow: var(--shadow-elevated); }
.accounts-dialog *, .accounts-dialog *::before, .accounts-dialog *::after { box-sizing: border-box; letter-spacing: 0; }
.accounts-dialog::backdrop { background: #18181b66; }
header { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 18px 24px; border-bottom: 1px solid var(--border); }
h2 { min-width: 0; font-size: 18px; margin: 0; overflow-wrap: anywhere; }.dialog-actions { display: flex; flex-shrink: 0; gap: 4px; }.dialog-actions button { width: 32px; height: 32px; }
.accounts-body { padding: 0 24px 20px; }footer { padding: 14px 24px; color: var(--text-2); font-size: 12px; border-top: 1px solid var(--border); }.empty { padding: 18px 0 0; color: var(--text-2); }
.account-list { list-style: none; padding: 0; margin: 0; }.account-list li { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 18px; padding: 20px 0; }.account-list li + li { border-top: 1px solid var(--border); }
.account-info { min-width: 0; display: grid; gap: 7px; }.account-info strong { overflow-wrap: anywhere; }.account-info p { margin: 0; color: var(--text-2); font-size: 12px; overflow-wrap: anywhere; }.account-status { display: flex; align-items: center; gap: 5px; font-size: 12px; }.account-status svg { flex-shrink: 0; }
.account-actions { display: flex; flex-direction: column; align-items: stretch; gap: 6px; }.account-actions button { min-height: 32px; white-space: nowrap; }
.identity-details { display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 7px 12px; margin: 5px 0 0; font-size: 12px; }.identity-details dt { color: var(--text-2); }.identity-details dd { display: flex; flex-direction: column; gap: 1px; min-width: 0; margin: 0; overflow-wrap: anywhere; }.identity-details code { color: var(--text-2); font-size: 11px; }
.default-badge { display: inline-block; padding: 1px 6px; margin-left: 6px; border-radius: 4px; font-size: 11px; font-weight: 500; background: var(--bg-2); color: var(--text-2); }.muted { color: var(--text-2); }.success { color: var(--success); }.warning { color: var(--warning, #a16207); }.danger { color: var(--error); }
.add-form { display: grid; gap: 9px; padding-top: 16px; border-top: 1px solid var(--border); }.add-form > label { font-weight: 600; }.add-form > div { display: flex; gap: 8px; }.add-form input { min-width: 0; flex: 1; padding: 9px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-0); color: var(--text-1); font: inherit; }.add-form button { flex-shrink: 0; }
.error,.notice { padding: 10px; border-radius: 6px; margin: 14px 0 0; overflow-wrap: anywhere; }.error { background: var(--error-bg); color: var(--error); }.notice { background: var(--info-bg); color: var(--text-1); }
.spin { animation: spin 1s linear infinite; }@keyframes spin { to { transform: rotate(360deg); } }.accounts-dialog :is(button,input):focus-visible { outline: 2px solid var(--info); outline-offset: 3px; }
@media(max-width: 540px) { header { padding: 14px 16px; }.accounts-body { padding: 0 16px 16px; }.account-list li { grid-template-columns: minmax(0, 1fr); gap: 14px; }.account-actions { flex-direction: row; flex-wrap: wrap; }.add-form > div { flex-direction: column; }.identity-details { grid-template-columns: 56px minmax(0, 1fr); gap: 7px 8px; }footer { padding: 12px 16px; } }
@media(prefers-reduced-motion: reduce) { .spin { animation: none; } }
</style>
