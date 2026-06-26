/**
 * Logger 模块公共导出
 *
 * 使用方式：
 * ```typescript
 * import { getLogger } from '@services/logger';
 * const logger = getLogger('ModuleName');
 * logger.info('...');
 * ```
 */

export { getLogger, initializeLogger } from './Logger';
export { LogLevel } from './types';
export type { LoggerConfig } from './types';
