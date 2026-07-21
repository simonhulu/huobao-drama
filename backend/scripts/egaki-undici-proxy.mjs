import { ProxyAgent, setGlobalDispatcher } from 'undici'

const proxy =
  process.env.IMAGE_HTTPS_PROXY ||
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.ALL_PROXY ||
  process.env.all_proxy ||
  process.env.IMAGE_HTTP_PROXY ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy

if (proxy) {
  setGlobalDispatcher(new ProxyAgent(proxy))
}
