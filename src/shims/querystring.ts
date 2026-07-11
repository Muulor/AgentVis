/**
 * querystring 浏览器兼容 shim
 *
 * 飞书 SDK (@larksuiteoapi/node-sdk) 内部使用 Node.js 的 querystring 模块。
 * Vite 在浏览器环境中将 Node.js 内置模块外部化，导致 querystring.parse 不可用。
 *
 * 此 shim 通过 vite.config.ts 的 resolve.alias 在构建阶段注入，
 * 使用浏览器原生 URLSearchParams API 提供等价功能。
 */

/**
 * 将 URL 查询字符串解析为键值对象
 *
 * 兼容 Node.js querystring.parse 的基本用法
 */
export function parse(str: string): Record<string, string | string[]> {
  const params = new URLSearchParams(str);
  const result: Record<string, string | string[]> = {};
  params.forEach((value, key) => {
    if (key in result) {
      // 多值场景：转为数组
      const existing = result[key];
      if (Array.isArray(existing)) {
        existing.push(value);
      } else if (existing !== undefined) {
        result[key] = [existing, value];
      }
    } else {
      result[key] = value;
    }
  });
  return result;
}

/**
 * 将对象序列化为 URL 查询字符串
 *
 * 兼容 Node.js querystring.stringify 的基本用法
 */
export function stringify(obj: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        params.append(key, toQueryStringValue(v));
      }
    } else {
      params.set(key, toQueryStringValue(value));
    }
  }
  return params.toString();
}

function toQueryStringValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' ? serialized : '';
  } catch {
    return '';
  }
}

// Node.js querystring 模块的其他方法的最小化 stub
export function escape(str: string): string {
  return encodeURIComponent(str);
}

export function unescape(str: string): string {
  return decodeURIComponent(str);
}

// 兼容 default export（某些 bundler 通过 import_querystring.default 访问）
export default { parse, stringify, escape, unescape };
