import { statfs } from 'node:fs/promises'

export const MEDIA_DISK_RESERVE_BYTES = 10 * 1024 ** 3
export type MediaDiskSpaceCheck = (directory: string, extraBytes?: number) => Promise<void>
type DiskProbe = (directory: string) => Promise<{ bavail: number; bsize: number }>

export async function assertMediaDiskSpace(directory: string, extraBytes = 0, probe: DiskProbe = statfs) {
  const disk = await probe(directory)
  const configured = Number(process.env.MEDIA_DISK_RESERVE_GIB)
  const reserve = Number.isFinite(configured) && configured >= 1 ? configured * 1024 ** 3 : MEDIA_DISK_RESERVE_BYTES
  if (disk.bavail * disk.bsize < reserve + Math.max(0, extraBytes)) {
    throw Object.assign(new Error(`磁盘空间不足，已暂停新增下载或渲染，需保留 ${Math.ceil(reserve / 1024 ** 3)} GiB；请先处理磁盘管理中的回收项目后重试`), { code: 'MEDIA_DISK_FULL' })
  }
}

export function watchMediaDiskSpace(directory: string, options: {
  check?: MediaDiskSpaceCheck; intervalMs?: number
} = {}) {
  const controller = new AbortController(), check = options.check ?? assertMediaDiskSpace
  let stopped = false, pending: Promise<void> | undefined
  const inspect = () => {
    if (stopped) return Promise.resolve()
    if (pending) return pending
    pending = (async () => {
      try { await check(directory) }
      catch (error) {
        if (!stopped) {
          stop()
          controller.abort(error)
        }
      } finally { pending = undefined }
    })()
    return pending
  }
  const timer = setInterval(() => { void inspect() }, Math.max(1, options.intervalMs ?? 1000))
  timer.unref?.()
  function stop() { stopped = true; clearInterval(timer) }
  return { signal: controller.signal, check: inspect, stop }
}
