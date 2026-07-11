/**
 * 工具 observation 脱敏工具。
 *
 * 仅处理会返回给 Agent/用户的 stdout、stderr、错误文本等观察内容；
 * 不改变实际子进程环境、请求体或 broker 响应体。
 */

import { translate } from '@/i18n';

function marker(): string {
  return translate('tools.common.redacted');
}

export function redactSensitiveObservation(input: string): string {
  if (!input) return input;

  const redacted = marker();
  let output = input;

  output = output.replace(
    /\b((?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|http_proxy|https_proxy|all_proxy|AGENTVIS_NETWORK_PROXY_URL|AGENTVIS_BROWSER_PROXY_SERVER)\s*[=:]\s*)["']?https?:\/\/[^\s"';&|]+/g,
    (_match, prefix: string) => `${prefix}${redacted}`
  );

  output = output.replace(
    /\b((?:AGENTVIS_BROKER_TOKEN|AGENTVIS_BROWSER_PROXY_PASSWORD|AGENTVIS_NETWORK_PROXY_PASSWORD)\s*[=:]\s*)["']?[^\s"';&|]+/g,
    (_match, prefix: string) => `${prefix}${redacted}`
  );

  output = output.replace(
    /\b((?:Authorization|Proxy-Authorization)\s*:\s*)[^\r\n]+/gi,
    (_match, prefix: string) => `${prefix}${redacted}`
  );

  output = output.replace(
    /\b((?:Cookie|Set-Cookie)\s*:\s*)[^\r\n]+/gi,
    (_match, prefix: string) => `${prefix}${redacted}`
  );

  output = output.replace(
    /\bhttps?:\/\/[^:@/\s"'`<>)]{1,128}:[^@/\s"'`<>)]{1,256}@[^\s"'`<>)]*/gi,
    redacted
  );

  output = output.replace(
    /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret|password)\s*[=:]\s*)["']?[^\s"',;}\]]+/gi,
    (_match, prefix: string) => `${prefix}${redacted}`
  );

  output = output.replace(
    /(["'](?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret|password)["']\s*:\s*)["'][^"']+["']/gi,
    (_match, prefix: string) => `${prefix}"${redacted}"`
  );

  output = output.replace(
    /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|key|secret|signature|sig|password)=)[^&#\s"'<>)]*/gi,
    (_match, prefix: string) => `${prefix}${redacted}`
  );

  output = output.replace(
    /(https?:\/\/)([^:@/\s]+):([^@/\s]+)@(127\.0\.0\.1|localhost|\[::1\])(:\d+)?/gi,
    (
      _match: string,
      _scheme: string,
      _user: string,
      _password: string,
      _host: string,
      _port: string | undefined
    ) => redacted
  );

  output = output.replace(
    /\bhttps?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+(?:\/[^\s"'`<>)]*)?/gi,
    redacted
  );

  return output;
}
