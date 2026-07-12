/**
 * FileTypeIcon - 文件类型图标组件
 *
 * 渲染轻量的 Lucide 图形或语言缩写徽标，不依赖 LSP 或外部图标主题运行时。
 */

import {
  Atom,
  Braces,
  CodeXml,
  Cog,
  Database,
  File,
  FileText,
  Folder,
  Hash,
  Image as ImageIcon,
  Settings,
  Terminal,
  type LucideIcon,
} from 'lucide-react';
import { cx } from '@utils/classNames';
import { resolveFileTypeIcon, type FileIconVisual } from './FileTypeIconRegistry';
import styles from './FileTypeIcon.module.css';

interface FileTypeIconProps {
  fileName: string;
  isDirectory?: boolean;
  size?: number;
}

interface BrandIconProps {
  size: number;
  className?: string;
}

/** Vue 官方双层 V 轮廓的小尺寸单色适配。 */
function VueFileIcon({ size, className }: BrandIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 22"
      className={cx(styles.icon, styles.brandIcon, className)}
      aria-hidden="true"
    >
      <path className={styles.vueOuter} d="M0 0h4.8L12 12.98 19.2 0H24L12 20.8 0 0Z" />
      <path className={styles.vueInner} d="M4.8 0h4.02L12 5.52 15.18 0h4.02L12 12.98 4.8 0Z" />
    </svg>
  );
}

/** Vite 闪电标志的小尺寸填充适配，避免完整渐变在 18px 下模糊。 */
function ViteFileIcon({ size, className }: BrandIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cx(styles.icon, styles.brandIcon, className)}
      aria-hidden="true"
    >
      <path d="M13.7 1.2 4.6 13.1h6.2l-1 9.7 9.6-13.4h-6.6l.9-8.2Z" />
    </svg>
  );
}

const VISUAL_ICON_MAP: Partial<Record<FileIconVisual, LucideIcon>> = {
  atom: Atom,
  braces: Braces,
  codeXml: CodeXml,
  cog: Cog,
  database: Database,
  file: File,
  fileText: FileText,
  folder: Folder,
  hash: Hash,
  image: ImageIcon,
  settings: Settings,
  terminal: Terminal,
};

export function FileTypeIcon({ fileName, isDirectory = false, size = 18 }: FileTypeIconProps) {
  const descriptor = resolveFileTypeIcon(fileName, isDirectory);
  const toneClass = styles[descriptor.tone];

  if (descriptor.visual === 'vue') {
    return <VueFileIcon size={size} className={toneClass} />;
  }

  if (descriptor.visual === 'vite') {
    return <ViteFileIcon size={size} className={toneClass} />;
  }

  if (descriptor.visual === 'badge') {
    const label = descriptor.label ?? '?';
    return (
      <span
        className={cx(styles.icon, styles.badge, toneClass)}
        style={{ width: size, height: size }}
        data-label-length={Math.min(label.length, 4)}
        aria-hidden="true"
      >
        {label}
      </span>
    );
  }

  const Icon = VISUAL_ICON_MAP[descriptor.visual] ?? File;
  return <Icon size={size} className={cx(styles.icon, toneClass)} aria-hidden="true" />;
}
