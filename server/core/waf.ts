/** 判断一个采集错误是否是「被验证码/风控页拦截」。 */
export function isWafError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /风控|验证或风控|本机浏览器|安全验证|captcha|challenge|cloudflare|滑块|人机|HTTP 403|returned HTTP 403|\b403\b/i.test(msg);
}

/** 网络层失败：WAF 也可能直接掐连接（fetch failed / 连接重置 / 超时），真实浏览器往往能连上。 */
export function isNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network|timed out|aborted|terminated/i.test(msg);
}

/** 是否应自动回退到浏览器采集：风控页 或 网络层失败。 */
export function shouldFallbackToBrowser(err: unknown): boolean {
  return isWafError(err) || isNetworkError(err);
}

/**
 * 域名级限流/封禁特征：429（明确限流）、边缘 52x（源站被拒/不可达）、403（封禁或风控）。
 * 出现这类错误说明「该域名此刻在拒绝我们这个出口 IP」，继续打同域名的其它店铺只会加深封禁，
 * 应当整域熔断、本轮跳过。
 */
export function isHostThrottledError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /\b(?:HTTP\s*)?(?:429|52[0-7])\b/i.test(msg) || /\b(?:HTTP\s*)?403\b|returned HTTP 403/i.test(msg);
}

/**
 * 上游临时错误：限流 / 源站 5xx / 边缘 52x / 网络超时。
 * 这类错误说明「采集器类型没错、只是站点此刻不可用」，应稍后重试同一采集器，
 * 不应触发「重新识别类型」自愈（那会换错采集器，且对已过载的源站加倍请求）。
 */
export function isRetryableUpstreamError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /\b(?:HTTP\s*)?(?:429|500|502|503|504|52[0-7])\b/i.test(msg) || isNetworkError(err);
}
