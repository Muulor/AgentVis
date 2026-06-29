/**
 * XlsxProcessor - Excel 表格处理器
 * 
 * 功能:
 * - Schema 优先提取 (列定义、数据类型)
 * - 智能采样 (head/uniform/stratified)
 * - 统计摘要生成
 * - Markdown 表格格式化
 */

import { BaseProcessor } from './BaseProcessor';
import type { DocumentExtension } from '../constants';
import type {
    DocumentMetadata,
    ProcessorContext,
    XlsxProcessorConfig,
} from '../types';

// ==================== 常量配置 ====================

/** 采样配置 */
const SAMPLING_CONFIG = {
    /** 保留头部行数 */
    HEAD_ROWS: 50,
    /** 采样中间行数 */
    SAMPLE_ROWS: 100,
    /** 保留尾部行数 */
    TAIL_ROWS: 50,
    /** 触发采样的总行数阈值 */
    SAMPLING_THRESHOLD: 300,
} as const;

// ==================== 默认配置 ====================

const DEFAULT_CONFIG: XlsxProcessorConfig = {
    maxTokens: 16000,
    truncationStrategy: 'head',
    maxRows: 1000,
    maxColumns: 50,
    samplingStrategy: 'uniform',
    emptyCellHandling: 'placeholder',
    extractSchema: true,
};

// ==================== XlsxProcessor 类 ====================

/**
 * Excel 表格处理器
 * 
 * 支持 .xlsx 和 .xls 文件
 */
export class XlsxProcessor extends BaseProcessor {
    readonly supportedExtensions: readonly DocumentExtension[] = ['xlsx', 'xls'];

    private xlsxConfig: XlsxProcessorConfig;

    constructor(config?: Partial<XlsxProcessorConfig>) {
        super(config);
        this.xlsxConfig = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * 处理 Excel 文档
     * 
     * @param context - 处理上下文
     * @param rawContent - 由 DocumentProcessingService.readRawContent() 预先解析的文本
     * @param warnings - 警告收集器
     */
    protected processInternal(
        context: ProcessorContext,
        rawContent: string,
        warnings: string[]
    ): { content: string; metadata: DocumentMetadata } {
        // 检查内容是否为空（由上层已调用后端解析，此处直接使用）
        if (!rawContent.trim()) {
            warnings.push('Excel document content is empty');
            return {
                content: '',
                metadata: {
                    fileType: context.extension,
                    originalSize: context.fileSize,
                },
            };
        }

        // 1. 解析工作表
        const sheets = this.parseSheets(rawContent);

        // 3. 构建元数据
        const metadata: DocumentMetadata = {
            fileType: context.extension,
            originalSize: context.fileSize,
            sheetCount: sheets.length,
        };

        // 4. 处理每个工作表
        const processedSheets: string[] = [];

        for (const sheet of sheets) {
            const processedSheet = this.processSheet(sheet, warnings);
            processedSheets.push(processedSheet);
        }

        // 5. 检测空内容
        if (processedSheets.length === 0 || processedSheets.every(s => !s.trim())) {
            warnings.push('Excel document has no valid content');
        }

        // 6. 构建最终输出
        const header = this.buildDocumentHeader(context, metadata);
        const content = header + processedSheets.join('\n\n---\n\n');

        return { content, metadata };
    }

    // ==================== 解析方法 ====================

    /**
     * 解析后端返回的 Markdown 格式工作表
     */
    private parseSheets(rawText: string): Sheet[] {
        const sheets: Sheet[] = [];

        // 按工作表标题分割
        const sheetRegex = /## (?:\u5de5\u4f5c\u8868|Worksheet|Sheet): (.+)\n\n([\s\S]*?)(?=\n## (?:\u5de5\u4f5c\u8868|Worksheet|Sheet):|$)/g;
        let match: RegExpExecArray | null;

        while ((match = sheetRegex.exec(rawText)) !== null) {
            if (match[1] && match[2]) {
                const rows = this.parseMarkdownTable(match[2].trim());
                sheets.push({
                    name: match[1],
                    rows,
                });
            }
        }

        // 如果没有匹配到工作表格式，可能是简单格式
        if (sheets.length === 0 && rawText.trim()) {
            const rows = this.parseMarkdownTable(rawText);
            if (rows.length > 0) {
                sheets.push({
                    name: 'Sheet1',
                    rows,
                });
            }
        }

        return sheets;
    }

    /**
     * 解析 Markdown 表格为二维数组
     */
    private parseMarkdownTable(tableText: string): string[][] {
        const rows: string[][] = [];
        const lines = tableText.split('\n');

        for (const line of lines) {
            // 防御性检查: 跳过 undefined 或空行
            if (!line) continue;
            // 跳过分隔行 (| --- |)
            if (/^\|[\s-]+\|$/.test(line.trim())) continue;
            if (!line.includes('|')) continue;

            // 解析行
            const cells = line
                .split('|')
                .slice(1, -1) // 移除首尾空元素
                .map(cell => cell.trim());

            if (cells.length > 0) {
                rows.push(cells);
            }
        }

        return rows;
    }

    /**
     * 处理单个工作表
     */
    private processSheet(sheet: Sheet, warnings: string[]): string {
        const { name, rows } = sheet;

        if (rows.length === 0) {
            // 添加空工作表警告
            warnings.push(`Worksheet "${name}" is empty`);
            return `## ${name}\n\n*(empty worksheet)*`;
        }

        const parts: string[] = [];
        parts.push(`## Worksheet: ${name}`);

        // 1. 提取 Schema (列定义)
        if (this.xlsxConfig.extractSchema && rows.length > 0) {
            const schema = this.extractSchema(rows);
            parts.push(`**Columns**: ${schema.columns.join(' | ')}`);
            parts.push(`**Data Types**: ${schema.types.join(' | ')}`);
            parts.push(`**Total Rows**: ${rows.length - 1}`); // 减去表头
        }

        // 2. 判断是否需要采样
        const dataRows = rows.slice(1); // 排除表头
        const needsSampling = dataRows.length > SAMPLING_CONFIG.SAMPLING_THRESHOLD;

        let sampledRows: string[][];
        let samplingInfo = '';

        if (needsSampling) {
            const result = this.sampleRows(dataRows);
            sampledRows = result.rows;
            samplingInfo = result.info;
            warnings.push(`Worksheet "${name}" is large (${dataRows.length} rows); sampled preview is shown`);
        } else {
            sampledRows = dataRows;
        }

        // 3. 构建表格预览
        const header = rows[0];
        if (header) {
            const previewTable = this.buildMarkdownTable(header, sampledRows);
            parts.push('');
            parts.push(`**Data Preview**${samplingInfo}:`);
            parts.push(previewTable);
        }

        // 4. 生成统计摘要 (仅对数值列)
        if (this.xlsxConfig.extractSchema && dataRows.length > 5 && rows[0]) {
            const stats = this.generateStatistics(rows[0], dataRows);
            if (stats) {
                parts.push('');
                parts.push('**Statistics Summary**:');
                parts.push(stats);
            }
        }

        return parts.join('\n');
    }

    // ==================== Schema 提取 ====================

    /**
     * 提取列定义和数据类型
     */
    private extractSchema(rows: string[][]): { columns: string[]; types: string[] } {
        const header = rows[0];
        if (!header) {
            return { columns: [], types: [] };
        }

        const columns = header.map(cell => cell || '(unnamed)');
        const types: string[] = [];

        // 分析前 10 行数据推断类型
        const sampleRows = rows.slice(1, 11);

        for (let colIndex = 0; colIndex < columns.length; colIndex++) {
            const colValues = sampleRows
                .map(row => row[colIndex] ?? '')
                .filter(val => val !== '');

            types.push(this.inferColumnType(colValues));
        }

        return { columns, types };
    }

    /**
     * 推断列数据类型
     */
    private inferColumnType(values: string[]): string {
        if (values.length === 0) return 'Unknown';

        let intCount = 0;
        let floatCount = 0;
        let dateCount = 0;

        for (const val of values) {
            if (/^-?\d+$/.test(val)) {
                intCount++;
            } else if (/^-?\d+(\.\d+)?$/.test(val)) {
                floatCount++;
            } else if (/^\d{4}[-/]\d{2}[-/]\d{2}/.test(val)) {
                dateCount++;
            }
        }

        const total = values.length;
        if (intCount > total * 0.8) return 'Int';
        if (floatCount > total * 0.8 || (intCount + floatCount) > total * 0.8) return 'Float';
        if (dateCount > total * 0.8) return 'Date';
        return 'String';
    }

    // ==================== 智能采样 ====================

    /**
     * 对大表格进行智能采样
     */
    private sampleRows(rows: string[][]): { rows: string[][]; info: string } {
        const total = rows.length;
        const { HEAD_ROWS, SAMPLE_ROWS, TAIL_ROWS } = SAMPLING_CONFIG;

        switch (this.xlsxConfig.samplingStrategy) {
            case 'head':
                // 只保留头部
                return {
                    rows: rows.slice(0, HEAD_ROWS + SAMPLE_ROWS),
                    info: ` (first ${Math.min(HEAD_ROWS + SAMPLE_ROWS, total)} / ${total} rows)`,
                };

            case 'uniform':
                // 均匀采样
                return this.uniformSample(rows, HEAD_ROWS, SAMPLE_ROWS, TAIL_ROWS);

            case 'stratified':
                // 分层采样 (按数据分布)
                // 简化版：等同于 uniform
                return this.uniformSample(rows, HEAD_ROWS, SAMPLE_ROWS, TAIL_ROWS);

            default:
                return { rows, info: '' };
        }
    }

    /**
     * 均匀采样实现
     */
    private uniformSample(
        rows: string[][],
        headCount: number,
        sampleCount: number,
        tailCount: number
    ): { rows: string[][]; info: string } {
        const total = rows.length;

        if (total <= headCount + sampleCount + tailCount) {
            return { rows, info: '' };
        }

        const result: string[][] = [];

        // 头部
        result.push(...rows.slice(0, headCount));

        // 中间均匀采样
        const middleStart = headCount;
        const middleEnd = total - tailCount;
        const middleCount = middleEnd - middleStart;
        const step = Math.floor(middleCount / sampleCount);

        for (let i = 0; i < sampleCount && middleStart + i * step < middleEnd; i++) {
            const row = rows[middleStart + i * step];
            if (row) {
                result.push(row);
            }
        }

        // 添加采样分隔标记
        result.push(['...', '...', '(sampled rows omitted)', '...']);

        // 尾部
        result.push(...rows.slice(-tailCount));

        const displayedCount = headCount + sampleCount + tailCount;
        return {
            rows: result,
            info: ` (${displayedCount} / ${total} rows)`,
        };
    }

    // ==================== 格式化输出 ====================

    /**
     * 构建 Markdown 表格
     */
    private buildMarkdownTable(header: string[], rows: string[][]): string {
        const lines: string[] = [];

        // 表头
        lines.push('| ' + header.join(' | ') + ' |');

        // 分隔符
        lines.push('| ' + header.map(() => '---').join(' | ') + ' |');

        // 数据行 (限制显示行数)
        const maxDisplayRows = Math.min(rows.length, this.xlsxConfig.maxRows);
        for (let i = 0; i < maxDisplayRows; i++) {
            const row = rows[i];
            if (row) {
                // 处理空单元格
                const processedRow = row.map(cell => {
                    if (!cell && this.xlsxConfig.emptyCellHandling === 'placeholder') {
                        return '-';
                    }
                    return cell || '';
                });
                lines.push('| ' + processedRow.join(' | ') + ' |');
            }
        }

        return lines.join('\n');
    }

    /**
     * 生成统计摘要
     */
    private generateStatistics(header: string[], dataRows: string[][]): string | null {
        const numericColumns: { name: string; values: number[] }[] = [];

        // 找出数值列
        for (let colIndex = 0; colIndex < header.length; colIndex++) {
            const colName = header[colIndex] ?? `Column ${colIndex + 1}`;
            const values: number[] = [];

            for (const row of dataRows) {
                const cell = row[colIndex] ?? '';
                const num = parseFloat(cell);
                if (!isNaN(num)) {
                    values.push(num);
                }
            }

            // 如果超过 80% 是数值，认为是数值列
            if (values.length > dataRows.length * 0.8) {
                numericColumns.push({ name: colName, values });
            }
        }

        if (numericColumns.length === 0) {
            return null;
        }

        // 生成统计
        const stats = numericColumns.slice(0, 3).map(col => { // 最多显示 3 列
            const sum = col.values.reduce((a, b) => a + b, 0);
            const avg = sum / col.values.length;
            const min = Math.min(...col.values);
            const max = Math.max(...col.values);

            return `- **${col.name}**: sum ${sum.toLocaleString()}, average ${avg.toFixed(2)}, range [${min}, ${max}]`;
        });

        return stats.join('\n');
    }

    /**
     * 构建文档头信息
     */
    private buildDocumentHeader(context: ProcessorContext, metadata: DocumentMetadata): string {
        const parts: string[] = [];

        parts.push(`# Excel Document: ${context.fileName}`);
        parts.push(`**Worksheet Count**: ${metadata.sheetCount ?? 1}`);
        parts.push(`**File Size**: ${(context.fileSize / 1024).toFixed(1)} KB`);

        return parts.join('\n') + '\n\n';
    }
}

// ==================== 内部类型 ====================

interface Sheet {
    name: string;
    rows: string[][];
}

// ==================== 导出单例 ====================

export const xlsxProcessor = new XlsxProcessor();
