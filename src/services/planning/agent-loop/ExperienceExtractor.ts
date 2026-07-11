/**
 * ExperienceExtractor - SA 执行经验提取器
 *
 * 从 SA 的 observations 中提取 `## EXECUTION_EXPERIENCE` 标记后的结构化内容，
 * 转换为可直写到记忆系统的经验文本。
 *
 * 设计原则：
 * - 纯函数，无副作用（不调用 LLM、不写数据库）
 * - 只负责解析文本，写入由 StateHandlers 负责
 * - 宽容解析：兼容有无 `- ` 前缀的条目格式
 */

import { getLogger } from '@services/logger';

const logger = getLogger('ExperienceExtractor');

/** 经验条目最大长度（超出截断，避免 token 浪费） */
const MAX_EXPERIENCE_LENGTH = 200;

/** 执行经验标记（SA 在 observations 中使用此标记分隔经验内容） */
const EXPERIENCE_SECTION_MARKER = '## EXECUTION_EXPERIENCE';

const UNCERTAIN_ROOT_CAUSE_PATTERNS = [
  /\b(?:maybe|might|may|probably|possibly|likely|seems|appears|suspect|guess)\b/i,
  /(?:可能|也许|大概|疑似|推测|猜测|似乎|看起来|不确定|无法确认|暂未确认|需要排查|需要确认)/,
  /(?:不是|并非|非|而非).{0,16}(?:代码|参数|应用层)/,
];

/**
 * 从 SA 的 observations 中提取执行经验
 *
 * 解析 `## EXECUTION_EXPERIENCE` 标记后的结构化内容，
 * 将多行经验条目转换为精炼的经验描述数组。
 *
 * 支持两种格式：
 * 1. 条目式：以 `- ` 开头的列表项
 * 2. 键值式：`建议：...` 形式（只提取"建议"行）
 *
 * @param observations - SA 的 observations 文本（可能包含也可能不包含标记）
 * @returns 精炼的经验描述数组（每条不超过 MAX_EXPERIENCE_LENGTH 字符）
 */
export function extractExperienceFeedback(observations?: string): string[] {
  if (!observations) return [];

  // 查找执行经验标记
  const markerIndex = observations.indexOf(EXPERIENCE_SECTION_MARKER);
  if (markerIndex === -1) return [];

  // 提取标记之后的内容
  const afterMarker = observations.substring(markerIndex + EXPERIENCE_SECTION_MARKER.length);

  // 截取到下一个 ## 标记或文本末尾（避免吃掉后续其他 Section）
  const nextSectionIndex = afterMarker.indexOf('\n## ');
  const experienceBlock =
    nextSectionIndex !== -1 ? afterMarker.substring(0, nextSectionIndex) : afterMarker;

  // 按行解析
  const lines = experienceBlock
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const experiences: string[] = [];

  for (const line of lines) {
    // 跳过空行和仅有标点的行
    if (line.length < 5) continue;

    // 提取建议行的内容（格式：`- Advice: ...` 或 `Advice: ...`）
    const suggestionMatch = line.match(/^-?\s*(?:Advice|Suggestion|Recommendation)[：:]\s*(.+)/i);
    if (suggestionMatch?.[1]) {
      const content = suggestionMatch[1].trim();
      if (shouldKeepExperience(content)) {
        experiences.push(truncateExperience(content));
      }
      continue;
    }

    // 提取以 `- ` 开头的列表项（排除"问题"和"解决"前缀，只保留"建议"或通用条目）
    const listItemMatch = line.match(/^-\s+(.+)/);
    if (listItemMatch?.[1]) {
      const content = listItemMatch[1].trim();
      // 跳过问题和解决过程前缀的行（这些是过程描述，不是精炼经验）
      if (/^(Problem|Issue|Solution|Resolved)[：:]/i.test(content)) continue;
      if (shouldKeepExperience(content)) {
        experiences.push(truncateExperience(content));
      }
    }
  }

  if (experiences.length > 0) {
    logger.trace(`[ExperienceExtractor] 提取到 ${experiences.length} 条经验:`);
    experiences.forEach((exp, i) => logger.trace(`  ${i + 1}. ${exp}`));
  }

  return experiences;
}

function shouldKeepExperience(content: string): boolean {
  if (content.length === 0) return false;
  return !UNCERTAIN_ROOT_CAUSE_PATTERNS.some((pattern) => pattern.test(content));
}

/**
 * 截断超长经验文本
 */
function truncateExperience(content: string): string {
  if (content.length <= MAX_EXPERIENCE_LENGTH) return content;
  return content.substring(0, MAX_EXPERIENCE_LENGTH - 3) + '...';
}
