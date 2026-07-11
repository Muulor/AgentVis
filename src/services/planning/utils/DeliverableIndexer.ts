/**
 * DeliverableIndexer - 交付物二进制文件自动索引
 *
 * SubAgent 完成后扫描工作目录，对尚未索引的二进制交付物
 * （xlsx/docx/pptx/pdf）调用 Rust parse_* 解析为文本后统一索引到知识库。
 *
 * 设计要点：
 * - 仅处理二进制格式，文本文件由 file_write 的 indexToKnowledgeBase 覆盖
 * - 使用 knowledgePaths 作为"已索引"判据，避免重复索引
 * - 使用 taskStartTime 限定扫描范围为本次任务新创建的文件，
 *   避免用户从知识库手动移除的文件被重新索引
 * - 失败不阻塞主流程
 */

import { invoke } from '@tauri-apps/api/core';
import { getLogger } from '@services/logger';
import { isKnowledgeOfficeFile } from '@services/rag/KnowledgeFileFilter';

const logger = getLogger('DeliverableIndexer');

/** 需要解析的二进制文件扩展名及其对应的 Rust parse 命令 */
const BINARY_FORMAT_PARSERS: Record<string, string> = {
  xlsx: 'parse_xlsx',
  docx: 'parse_docx',
  pdf: 'parse_pdf',
  pptx: 'parse_pptx',
};

/** 所有可被识别的二进制交付物扩展名 */
const BINARY_EXTENSIONS = new Set(Object.keys(BINARY_FORMAT_PARSERS));

/**
 * 扫描工作目录中本次任务新创建的二进制交付物并自动索引到知识库
 *
 * @param agentId - Agent ID
 * @param workdir - SubAgent 工作目录（deliverables/<hub>/<agent>）
 * @param taskStartTime - 本次任务的开始时间戳（毫秒），
 *                        仅索引 mtime >= taskStartTime 的文件，
 *                        避免用户手动移除的旧文件被重新索引
 */
export async function indexUnindexedDeliverables(
  agentId: string,
  workdir: string,
  taskStartTime: number
): Promise<void> {
  try {
    // 检查 autoIndexDeliverables 开关（默认开启）
    const { useAgentStore } = await import('@stores/agentStore');
    const agentForCheck = useAgentStore.getState().agents.find((a) => a.id === agentId);
    if (agentForCheck?.autoIndexDeliverables === false) {
      logger.trace('[DeliverableIndexer] autoIndexDeliverables 已关闭，跳过扫描');
      return;
    }

    // 1. 列出工作目录中的所有文件
    const { readDir } = await import('@tauri-apps/plugin-fs');
    const entries = await readDir(workdir);

    // 2. 筛选出二进制格式的文件
    const { stat } = await import('@tauri-apps/plugin-fs');
    const { join } = await import('@tauri-apps/api/path');
    const binaryFiles: Array<{ name: string; path: string; ext: string }> = [];
    for (const entry of entries) {
      if (!entry.name || entry.isDirectory) continue;
      const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
      if (BINARY_EXTENSIONS.has(ext) && isKnowledgeOfficeFile(entry.name)) {
        const fullPath = await join(workdir, entry.name);

        // 仅处理本次任务期间创建/修改的文件
        // 防止用户从知识库手动删除后被重新索引
        try {
          const fileStat = await stat(fullPath);
          const mtime = fileStat.mtime instanceof Date ? fileStat.mtime.getTime() : 0;
          if (mtime < taskStartTime) {
            logger.trace(`[DeliverableIndexer] 跳过旧文件（非本次任务产物）: ${entry.name}`);
            continue;
          }
        } catch {
          // stat 失败时保守跳过，不冒险索引旧文件
          logger.warn(`[DeliverableIndexer] 无法获取文件状态，跳过: ${entry.name}`);
          continue;
        }

        binaryFiles.push({ name: entry.name, path: fullPath, ext });
      }
    }

    if (binaryFiles.length === 0) return;

    // 3. 获取当前 knowledgePaths，判断哪些文件尚未索引（复用已导入的 useAgentStore）
    const agent = useAgentStore.getState().agents.find((a) => a.id === agentId);
    const currentPaths: string[] = agent?.knowledgePaths
      ? (JSON.parse(agent.knowledgePaths) as unknown as string[])
      : [];
    const currentPathSet = new Set(currentPaths);

    const unindexedFiles = binaryFiles.filter((f) => !currentPathSet.has(f.path));
    if (unindexedFiles.length === 0) {
      logger.trace('[DeliverableIndexer] 无新增二进制交付物需要索引');
      return;
    }

    logger.trace(`[DeliverableIndexer] 发现 ${unindexedFiles.length} 个未索引的二进制交付物`);

    // 4. 逐个解析并索引
    const { getRagService } = await import('@services/rag');
    const ragService = getRagService();
    const newPaths: string[] = [];

    for (const file of unindexedFiles) {
      try {
        const parseCommand = BINARY_FORMAT_PARSERS[file.ext];
        if (!parseCommand) continue;

        // 调用 Rust 解析命令将二进制内容转为文本
        const parsedContent = await invoke<string>(parseCommand, { filePath: file.path });
        if (!parsedContent || parsedContent.trim().length === 0) {
          logger.warn(`[DeliverableIndexer] 解析内容为空，跳过: ${file.name}`);
          continue;
        }

        // 先清除旧向量（幂等）
        await ragService.deleteDocumentIndex(agentId, file.path);

        // 索引到 RAG
        const chunkCount = await ragService.indexDocument(
          agentId,
          file.path, // documentId 统一使用 filePath
          parsedContent,
          {
            fileName: file.name,
            filePath: file.path,
            documentType: 'text',
          }
        );

        newPaths.push(file.path);
        logger.trace(`[DeliverableIndexer] ✅ 已索引: ${file.name} (${chunkCount} 个块)`);
      } catch (fileError) {
        // 单个文件解析失败不影响其他文件
        logger.warn(`[DeliverableIndexer] 解析失败: ${file.name}`, fileError);
      }
    }

    // 5. 将新索引文件路径同步到 knowledgePaths
    if (newPaths.length > 0) {
      const updatedPaths = [...currentPaths, ...newPaths];
      const newKnowledgePaths = JSON.stringify(updatedPaths);

      // 更新 Store
      useAgentStore.getState().updateAgent(agentId, { knowledgePaths: newKnowledgePaths });

      // 持久化到后端
      try {
        await invoke('agent_update', {
          id: agentId,
          request: { knowledge_paths: newKnowledgePaths },
        });
      } catch (persistError) {
        logger.warn('[DeliverableIndexer] 持久化 knowledgePaths 失败:', persistError);
      }

      logger.trace(`[DeliverableIndexer] 已同步 ${newPaths.length} 个文件到知识库`);
    }
  } catch (error) {
    // 整体失败不阻塞 SubAgent 流程
    logger.warn('[DeliverableIndexer] 扫描索引失败（不影响主流程）:', error);
  }
}
