/**
 * WidgetIcon - Widget 通用图标组件
 *
 * 支持两种图标格式：
 * 1. Emoji：直接显示文本（如 "🏗️"）
 * 2. Lucide 图标名：渲染对应的 lucide-react 图标（如 "Palette"、"Building"）
 *
 * 识别规则：
 * - 如果字符串是纯 ASCII 字母组合且首字母大写（PascalCase），尝试作为 Lucide 图标渲染
 * - 否则作为 Emoji/文本直接显示
 *
 * 不引入新依赖，复用项目已有的 lucide-react。
 */

import { memo, useMemo } from 'react';
import { icons } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// ============================================================================
// 类型定义
// ============================================================================

interface WidgetIconProps {
  /** 图标标识：Emoji 字符串或 Lucide 图标名（PascalCase，如 Palette、Building2） */
  icon: string;
  /** 图标尺寸（px），默认 18 */
  size?: number;
  /** 自定义 CSS className */
  className?: string;
}

// ============================================================================
// Lucide 图标名检测
// ============================================================================

/**
 * 判断字符串是否可能是 Lucide 图标名
 *
 * Lucide 图标名规则：PascalCase，由 ASCII 字母和数字组成
 * 例如：Palette, Building2, ArrowRight, ChevronDown
 *
 * 排除规则：包含非 ASCII 字符的一定是 Emoji
 */
const LUCIDE_NAME_PATTERN = /^[A-Z][a-zA-Z0-9]+$/;

function isLucideIconName(value: string): boolean {
  return LUCIDE_NAME_PATTERN.test(value);
}

/**
 * 从 lucide-react 的 icons 对象中查找图标组件
 *
 * lucide-react 导出的 icons 是 Record<string, LucideIcon>
 * key 是 PascalCase 图标名
 */
function resolveLucideIcon(name: string): LucideIcon | null {
  // 直接查找（PascalCase 完全匹配）
  const icon = (icons as Record<string, LucideIcon>)[name];
  if (icon) return icon;

  return null;
}

// ============================================================================
// 组件实现
// ============================================================================

export const WidgetIcon = memo(function WidgetIcon({
  icon,
  size = 18,
  className,
}: WidgetIconProps) {
  // 尝试解析为 Lucide 图标
  const resolved = useMemo(() => {
    if (isLucideIconName(icon)) {
      const found = resolveLucideIcon(icon);
      // 找到 → 渲染对应图标；未找到 → 标记为 Lucide 类型但 fallback
      return { isLucideName: true, component: found };
    }
    return { isLucideName: false, component: null };
  }, [icon]);

  // 渲染 Lucide 图标
  if (resolved.component) {
    return <resolved.component size={size} className={className} strokeWidth={1.75} />;
  }

  // PascalCase 但 lucide-react 中未找到 → 使用 Circle 作为通用 fallback
  // 避免将 "AlignCenter" 等文本原样显示
  if (resolved.isLucideName) {
    const Fallback = resolveLucideIcon('Circle');
    if (Fallback) {
      return <Fallback size={size} className={className} strokeWidth={1.75} />;
    }
  }

  // 渲染 Emoji / 文本
  return (
    <span className={className} style={{ fontSize: size, lineHeight: 1 }}>
      {icon}
    </span>
  );
});
