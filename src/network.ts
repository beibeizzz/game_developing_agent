import { EnvHttpProxyAgent, fetch as proxyFetch } from 'undici';
const dispatcher = new EnvHttpProxyAgent();
export function publicUrl(value: string) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[|172\.(1[6-9]|2\d|3[01])\.)/i.test(url.hostname)
  )
    throw new Error('仅接受公共 HTTP/HTTPS 参考链接');
  return url;
}
export async function webFetch(value: string, timeout = 20000) {
  let url = publicUrl(value);
  for (let i = 0; i < 5; i++) {
    const result = await proxyFetch(url, {
      dispatcher,
      redirect: 'manual',
      headers: { 'User-Agent': 'LocalGameAgent/0.1 (design reference research)' },
      signal: AbortSignal.timeout(timeout),
    });
    if ([301, 302, 303, 307, 308].includes(result.status) && result.headers.get('location')) {
      await result.body?.cancel();
      url = publicUrl(new URL(result.headers.get('location')!, url).href);
      continue;
    }
    if (!result.ok) {
      await result.body?.cancel();
      throw new Error(`参考来源 HTTP ${result.status}: ${url.hostname}`);
    }
    return result;
  }
  throw new Error('参考链接重定向过多');
}
