/**
 * XML 协议解析器
 *
 * 解析 LLM 输出的 XML 修改协议，提取修改指令
 */

import type { Modification, ModificationBatch, OperationType } from './types';

// ==================== 常量定义 ====================

/** 有效的操作类型集合 */
const VALID_OPERATIONS: Set<OperationType> = new Set([
  'REPLACE',
  'INSERT_AFTER',
  'INSERT_BEFORE',
  'DELETE',
]);

// ==================== 错误类型 ====================

/**
 * 协议解析错误
 */
export class ProtocolParseError extends Error {
  constructor(
    message: string,
    public readonly details?: string
  ) {
    super(message);
    this.name = 'ProtocolParseError';
  }
}

// ==================== 解析器类 ====================

/**
 * XML 修改协议解析器
 *
 * 负责解析 LLM 输出的 XML 格式修改指令，支持单个和批量修改
 */
export class ProtocolParser {
  private parser: DOMParser;

  constructor() {
    this.parser = new DOMParser();
  }

  /**
   * 解析单个修改协议
   *
   * @param xml XML 字符串，包含单个 <modification> 标签
   * @returns 解析后的 Modification 对象
   * @throws ProtocolParseError 解析失败时抛出
   *
   * @example
   * ```typescript
   * const parser = new ProtocolParser();
   * const mod = parser.parseModification(`
   *   <modification>
   *     <file>src/main.ts</file>
   *     <operation>REPLACE</operation>
   *     <search>old code</search>
   *     <replace>new code</replace>
   *   </modification>
   * `);
   * ```
   */
  parseModification(xml: string): Modification {
    const doc = this.parseXml(xml);
    const modElement = doc.querySelector('modification');

    if (!modElement) {
      throw new ProtocolParseError(
        'No <modification> tag found',
        'Ensure the XML contains a valid modification element'
      );
    }

    return this.extractModification(modElement);
  }

  /**
   * 解析批量修改协议
   *
   * @param xml XML 字符串，包含 <modifications> 或多个 <modification> 标签
   * @returns 解析后的 Modification 数组
   * @throws ProtocolParseError 解析失败时抛出
   *
   * @example
   * ```typescript
   * const parser = new ProtocolParser();
   * const mods = parser.parseModifications(`
   *   <modifications>
   *     <modification>...</modification>
   *     <modification>...</modification>
   *   </modifications>
   * `);
   * ```
   */
  parseModifications(xml: string): Modification[] {
    const doc = this.parseXml(xml);

    // 优先查找 <modifications> 容器
    const container = doc.querySelector('modifications');
    const modElements = container
      ? container.querySelectorAll('modification')
      : doc.querySelectorAll('modification');

    if (modElements.length === 0) {
      throw new ProtocolParseError(
        'No <modification> tags found',
        'Ensure the XML contains at least one modification element'
      );
    }

    const modifications: Modification[] = [];
    const errors: string[] = [];

    modElements.forEach((element, index) => {
      try {
        modifications.push(this.extractModification(element));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`Modification ${index + 1} failed to parse: ${message}`);
      }
    });

    // 如果部分解析成功，返回成功的部分；如果全部失败，抛出错误
    if (modifications.length === 0 && errors.length > 0) {
      throw new ProtocolParseError('All modifications failed to parse', errors.join('\n'));
    }

    return modifications;
  }

  /**
   * 解析批量修改协议为 ModificationBatch
   */
  parseModificationBatch(xml: string): ModificationBatch {
    return {
      modifications: this.parseModifications(xml),
    };
  }

  /**
   * 尝试从文本中提取 XML 修改协议
   *
   * 用于处理 LLM 输出中混合了普通文本和 XML 的情况
   *
   * @param text 可能包含 XML 的文本
   * @returns 提取到的 Modification 数组
   */
  extractFromText(text: string): Modification[] {
    // 匹配 <modification>...</modification> 或 <modifications>...</modifications>
    const modificationPattern = /<modification>[\s\S]*?<\/modification>/gi;
    const modificationsPattern = /<modifications>[\s\S]*?<\/modifications>/gi;

    // 优先尝试提取整个 <modifications> 块
    const batchMatches = text.match(modificationsPattern);
    if (batchMatches && batchMatches.length > 0) {
      const results: Modification[] = [];
      for (const match of batchMatches) {
        try {
          results.push(...this.parseModifications(match));
        } catch {
          // 忽略解析失败的块，继续尝试其他
        }
      }
      if (results.length > 0) {
        return results;
      }
    }

    // 回退到单独的 <modification> 块
    const singleMatches = text.match(modificationPattern);
    if (singleMatches && singleMatches.length > 0) {
      const results: Modification[] = [];
      for (const match of singleMatches) {
        try {
          results.push(this.parseModification(match));
        } catch {
          // 忽略解析失败的块
        }
      }
      return results;
    }

    return [];
  }

  /**
   * 验证操作类型是否有效
   */
  isValidOperation(operation: string): operation is OperationType {
    return VALID_OPERATIONS.has(operation as OperationType);
  }

  // ==================== 私有方法 ====================

  /**
   * 解析 XML 字符串为 Document
   */
  private parseXml(xml: string): Document {
    // 预处理：确保 XML 有根元素
    const trimmed = xml.trim();
    const wrappedXml = trimmed.startsWith('<') ? trimmed : `<root>${trimmed}</root>`;

    const doc = this.parser.parseFromString(wrappedXml, 'text/xml');

    // 检查解析错误
    const parseError = doc.querySelector('parsererror');
    if (parseError) {
      throw new ProtocolParseError(
        'XML parse failed',
        parseError.textContent || 'Unknown parse error'
      );
    }

    return doc;
  }

  /**
   * 从 modification 元素提取 Modification 对象
   */
  private extractModification(element: Element): Modification {
    // 提取字段（file 可选，因为可能已通过外部参数指定）
    const file = this.getElementText(element, 'file') ?? '';
    const operationStr = this.getElementText(element, 'operation');
    const search = this.getElementText(element, 'search');

    if (!operationStr) {
      throw new ProtocolParseError('Missing required <operation> tag');
    }

    // 验证操作类型
    const operation = operationStr.toUpperCase();
    if (!this.isValidOperation(operation)) {
      throw new ProtocolParseError(
        `Invalid operation type: ${operationStr}`,
        `Valid values: ${Array.from(VALID_OPERATIONS).join(', ')}`
      );
    }

    if (!search) {
      throw new ProtocolParseError('Missing required <search> tag');
    }

    // 提取可选字段
    const replace = this.getElementText(element, 'replace');
    const description = this.getElementText(element, 'description');

    // 验证：非 DELETE 操作必须有 replace
    if (operation !== 'DELETE' && !replace) {
      throw new ProtocolParseError(
        `${operation} operation requires a <replace> tag`,
        'Only DELETE operations can omit replace content'
      );
    }

    return {
      file,
      operation: operation as OperationType,
      search,
      replace: replace ?? undefined,
      description: description ?? undefined,
    };
  }

  /**
   * 获取子元素的文本内容
   */
  private getElementText(parent: Element, tagName: string): string | null {
    const element = parent.querySelector(tagName);
    if (!element) {
      return null;
    }
    // 使用 textContent 获取所有文本，包括嵌套的空白和换行
    return element.textContent || null;
  }
}

// ==================== 导出单例 ====================

/** 默认解析器实例 */
export const protocolParser = new ProtocolParser();
