/**
 * PortAllocator - 预览端口分配器
 *
 * 为 Vite Dev Server 分配本地端口，避免与应用本身（1420）
 * 和 Vite 默认端口（5173）冲突。
 *
 * 端口范围 [3100, 3199]，足以支持并行预览场景。
 *
 * 重要：allocate() 是异步方法，会通过 fetch 探测端口是否被孤儿进程占用，
 * 避免分配实际已被使用的端口。
 */

import { getLogger } from '@services/logger';
import { PREVIEW_PORT_RANGE_END, PREVIEW_PORT_RANGE_START } from './previewUrlPolicy';

const logger = getLogger('PortAllocator');

/** 端口分配范围 */

/** fetch 探测超时时间（毫秒），仅用于快速判断端口是否被占用 */
const PROBE_TIMEOUT_MS = 300;

/**
 * 端口分配器
 *
 * 维护一个已分配端口的集合，按顺序分配可用端口。
 * 单例模式运行，所有预览共享同一分配器。
 */
class PortAllocator {
  /** 已分配的端口集合 */
  private readonly allocatedPorts: Set<number> = new Set();

  /**
   * 分配一个可用端口
   *
   * 从范围起始顺序扫描，返回第一个既未被内部标记、
   * 也未被外部进程占用的端口。
   *
   * 通过 fetch 探测检测孤儿进程占用的端口，避免端口冲突。
   *
   * @returns 分配的端口号
   * @throws 当端口范围耗尽时抛出异常
   */
  async allocate(): Promise<number> {
    for (let port = PREVIEW_PORT_RANGE_START; port <= PREVIEW_PORT_RANGE_END; port++) {
      if (this.allocatedPorts.has(port)) {
        continue;
      }

      // 探测端口是否被外部进程占用（孤儿 Vite 等）
      const isOccupied = await this.isPortOccupied(port);
      if (isOccupied) {
        logger.warn(`[PortAllocator] 端口 ${port} 被外部进程占用，跳过`);
        continue;
      }

      this.allocatedPorts.add(port);
      logger.trace(`[PortAllocator] 分配端口: ${port}`);
      return port;
    }
    throw new Error(
      `[PortAllocator] Port range [${PREVIEW_PORT_RANGE_START}-${PREVIEW_PORT_RANGE_END}] is exhausted; unable to allocate a new port`
    );
  }

  /**
   * 释放已分配的端口
   *
   * 预览关闭时调用，将端口归还到可用池。
   */
  release(port: number): void {
    if (this.allocatedPorts.has(port)) {
      this.allocatedPorts.delete(port);
      logger.trace(`[PortAllocator] 释放端口: ${port}`);
    }
  }

  /**
   * 获取当前已分配的端口数量（用于调试）
   */
  getAllocatedCount(): number {
    return this.allocatedPorts.size;
  }

  /**
   * 重置所有分配（应用重启时使用）
   */
  reset(): void {
    this.allocatedPorts.clear();
    logger.trace('[PortAllocator] 已重置所有端口分配');
  }

  /**
   * 探测端口是否被外部进程占用
   *
   * 使用快速 fetch + 短超时判断。如果端口上有 HTTP 服务响应，
   * 说明被孤儿进程占用。fetch 失败（连接拒绝）则端口空闲。
   */
  private async isPortOccupied(port: number): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

      const response = await fetch(`http://127.0.0.1:${port}`, {
        signal: controller.signal,
        // Occupancy probing only needs to know whether an HTTP listener answered.
        // Opaque no-cors responses still resolve and cannot be misclassified as
        // "free" merely because an unrelated local server omits CORS headers.
        mode: 'no-cors',
      });

      clearTimeout(timeoutId);
      // 有响应（任何状态码），说明端口已被占用
      void response.body?.cancel();
      return true;
    } catch {
      // 连接拒绝或超时 → 端口空闲
      return false;
    }
  }
}

/** 端口分配器单例 */
export const portAllocator = new PortAllocator();
