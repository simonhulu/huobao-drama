export function redactHistoryJobMessage(value: unknown, apiKeys: string[] = []) {
  let message=value instanceof Error ? value.message : String(value)
  for(const key of apiKeys)if(key)message=message.replaceAll(key,'[redacted]')
  return message.replaceAll('“已登录，继续采集”','“检测登录状态”')
    .replace(/Bearer\s+\S+/gi,'Bearer [redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/g,'[网址省略]')
    .replace(/\/(?:Users|home|private|tmp|var)\/[^\s"'<>]+/g,'[本地路径省略]')
    .slice(0,2000)
}
