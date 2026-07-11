/**
 * 手动事实工具函数
 *
 * 封装用户在记忆面板主动新增事实时的创建请求和来源识别逻辑，
 * 避免 UI 组件直接拼装存储层 metadata。
 */

import type { LongTermFactCategory } from '@services/memory/types';

const MANUAL_FACT_SOURCE = 'manual';

export interface ManualFactCreateParams {
  agentId: string;
  content: string;
  category: LongTermFactCategory;
}

export interface ManualFactCreateRequest {
  agentId: string;
  layer: 'fact';
  content: string;
  category: LongTermFactCategory;
  importance: number;
  sourceMessageIds: null;
  metadataJson: string;
}

interface FactMetadata {
  source?: string;
}

export function buildManualFactCreateRequest({
  agentId,
  content,
  category,
}: ManualFactCreateParams): ManualFactCreateRequest {
  return {
    agentId,
    layer: 'fact',
    content,
    category,
    importance: 5,
    sourceMessageIds: null,
    metadataJson: JSON.stringify({ source: MANUAL_FACT_SOURCE }),
  };
}

export function isManualFactMetadata(metadataJson: string | null | undefined): boolean {
  if (!metadataJson) {
    return false;
  }

  try {
    const metadata = JSON.parse(metadataJson) as FactMetadata;
    return metadata.source === MANUAL_FACT_SOURCE;
  } catch {
    return false;
  }
}
