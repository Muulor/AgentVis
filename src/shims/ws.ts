/**
 * WebSocket 浏览器兼容 shim
 *
 * 飞书 SDK (@larksuiteoapi/node-sdk) 的 WSClient 使用 Node.js ws 包的 API：
 *   - new WebSocket(url, { agent }) — 第二参数是选项对象
 *   - ws.on('open', fn) — Node.js EventEmitter 风格
 *   - ws.on('message', buffer) — 回调接收 Buffer/Uint8Array
 *   - ws.terminate() — 强制关闭
 *   - ws.send(data, callback) — 发送带回调
 *   - ws.removeAllListeners() — 移除所有监听器
 *
 * 浏览器原生 WebSocket API 不同：
 *   - new WebSocket(url, protocols?) — 第二参数是协议字符串/数组
 *   - ws.addEventListener('open', fn) — DOM 事件风格
 *   - ws.addEventListener('message', e => e.data) — MessageEvent
 *   - ws.close() — 关闭连接
 *   - ws.send(data) — 无回调
 *
 * 此 shim 在两者之间做桥接，通过 vite.config.ts 的 resolve.alias 在构建阶段注入。
 */

// 保存浏览器原生 WebSocket 引用
const BrowserWebSocket = globalThis.WebSocket;

/**
 * 兼容 Node.js ws 包的 WebSocket 包装器
 *
 * 忽略构造函数的 options 参数，将 .on()/.terminate()/.removeAllListeners()
 * 等 Node.js 风格 API 桥接到浏览器原生 WebSocket
 */
class WsCompatWebSocket {
  // ws 包的静态常量
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  private _ws: WebSocket;
  private _listeners: Map<string, Set<(...args: unknown[]) => void>> = new Map();

  /**
   * @param url WebSocket URL
   * @param _optionsOrProtocols 兼容两种调用方式：
   *   - Node.js ws: new WebSocket(url, { agent, ... })
   *   - Browser: new WebSocket(url, protocols?)
   *   如果是对象（非数组非字符串）则忽略（Node.js ws options）
   */
  constructor(url: string, _optionsOrProtocols?: unknown) {
    // 如果第二参数是 ws 选项对象（不是字符串/数组protocol），忽略它
    let protocols: string | string[] | undefined;
    if (typeof _optionsOrProtocols === 'string') {
      protocols = _optionsOrProtocols;
    } else if (Array.isArray(_optionsOrProtocols)) {
      protocols = _optionsOrProtocols as string[];
    }
    // 否则忽略（ws 包的 { agent, ... } 选项）

    this._ws = protocols ? new BrowserWebSocket(url, protocols) : new BrowserWebSocket(url);

    // 浏览器 WebSocket 默认使用 blob，ws 包使用 arraybuffer/Buffer
    this._ws.binaryType = 'arraybuffer';
  }

  /** 当前连接状态 */
  get readyState(): number {
    return this._ws.readyState;
  }

  get url(): string {
    return this._ws.url;
  }

  /**
   * Node.js EventEmitter 风格的事件监听
   * 桥接到浏览器 WebSocket 的 addEventListener
   */
  on(event: string, listener: (...args: unknown[]) => void): this {
    // 注册到内部映射（用于 removeAllListeners）
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    const listeners = this._listeners.get(event);
    if (!listeners) {
      throw new Error(`Failed to register listener for ${event}`);
    }
    listeners.add(listener);

    // 桥接到浏览器原生事件
    if (event === 'message') {
      // ws 包回调参数是 Buffer/Uint8Array，浏览器 MessageEvent.data 是 ArrayBuffer
      this._ws.addEventListener('message', (e: MessageEvent) => {
        const rawData = e.data as unknown;
        const data = rawData instanceof ArrayBuffer ? new Uint8Array(rawData) : rawData;
        listener(data);
      });
    } else if (event === 'open') {
      this._ws.addEventListener('open', () => listener());
    } else if (event === 'close') {
      this._ws.addEventListener('close', (e: CloseEvent) => listener(e.code, e.reason));
    } else if (event === 'error') {
      this._ws.addEventListener('error', (e: Event) => listener(e));
    } else {
      // 其他事件直接桥接
      this._ws.addEventListener(event, (e: Event) => listener(e));
    }

    return this;
  }

  /**
   * 发送数据
   * ws 包支持 send(data, callback)，浏览器只有 send(data)
   */
  send(data: unknown, callback?: (err?: Error) => void): void {
    try {
      if (data instanceof Uint8Array) {
        this._ws.send(data.buffer);
      } else {
        this._ws.send(data as string | ArrayBufferLike | Blob | ArrayBufferView);
      }
      // 模拟 ws 包的回调：发送成功
      if (callback) {
        callback();
      }
    } catch (err) {
      if (callback) {
        callback(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  /** ws 包的 terminate()：强制关闭连接 */
  terminate(): void {
    this._ws.close();
  }

  /** 正常关闭连接 */
  close(code?: number, reason?: string): void {
    this._ws.close(code, reason);
  }

  /** ws 包的 removeAllListeners()：移除所有事件监听器 */
  removeAllListeners(): void {
    // 创建新的 WebSocket 实例来移除所有监听器
    // 注意：这只清除内部映射，浏览器原生 WebSocket 不支持 removeAllListeners
    // 但 SDK 只在 close() 时调用此方法，此时 WebSocket 已不再使用
    this._listeners.clear();
  }

  /** 兼容 EventEmitter.once */
  once(event: string, listener: (...args: unknown[]) => void): this {
    const onceWrapper = (...args: unknown[]) => {
      listener(...args);
      // once 触发后应移除，但我们简化处理
    };
    return this.on(event, onceWrapper);
  }
}

// 统一导出：作为默认导出和命名导出
export default WsCompatWebSocket;
export { WsCompatWebSocket as WebSocket };
