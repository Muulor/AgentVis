/**
 * ThinkingStream - 思维流组件
 *
 * 展示单个思维阶段的内容
 *
 */

import { useEffect, useState } from 'react';
import styles from './ThinkingStream.module.css';

const SMOOTH_FRAME_MS = 16;
const DEFAULT_MAX_CHARS_PER_FRAME = 18;
const CATCH_UP_FRAME_COUNT = 12;

function getNextChunkSize(remainingChars: number, maxCharsPerFrame: number): number {
  return Math.max(1, Math.min(maxCharsPerFrame, Math.ceil(remainingChars / CATCH_UP_FRAME_COUNT)));
}

export interface ThinkingStreamProps {
  /** 完整内容 */
  content: string;
  /** 是否显示闪烁光标 */
  showCursor?: boolean;
  /** 是否正在输入中 */
  isActive?: boolean;
  /** 是否平滑显示新增内容 */
  enableTypewriter?: boolean;
  /** 每帧最多显示的字符数 */
  typeSpeed?: number;
}

/**
 * 思维流组件
 *
 * 用于展示 Agent 的思维内容
 */
export function ThinkingStream({
  content,
  showCursor = true,
  isActive = false,
  enableTypewriter = true,
  typeSpeed,
}: ThinkingStreamProps) {
  const [displayContent, setDisplayContent] = useState(content);
  const maxCharsPerFrame =
    typeSpeed && typeSpeed > 0 ? Math.max(1, Math.round(typeSpeed)) : DEFAULT_MAX_CHARS_PER_FRAME;

  useEffect(() => {
    if (!enableTypewriter || !isActive) {
      setDisplayContent(content);
      return;
    }

    if (!content) {
      setDisplayContent('');
      return;
    }

    if (!content.startsWith(displayContent)) {
      setDisplayContent(content);
      return;
    }

    if (displayContent.length >= content.length) {
      return;
    }

    const timer = window.setTimeout(() => {
      setDisplayContent((current) => {
        if (!content.startsWith(current)) {
          return content;
        }

        const remainingChars = content.length - current.length;
        if (remainingChars <= 0) {
          return current;
        }

        const chunkSize = getNextChunkSize(remainingChars, maxCharsPerFrame);
        return current + content.slice(current.length, current.length + chunkSize);
      });
    }, SMOOTH_FRAME_MS);

    return () => window.clearTimeout(timer);
  }, [content, displayContent, enableTypewriter, isActive, maxCharsPerFrame]);

  // 是否显示光标
  const shouldShowCursor = showCursor && isActive;

  if (!displayContent && !content) {
    return null;
  }

  return (
    <div className={styles.container}>
      <span className={styles.text}>{displayContent}</span>
      {shouldShowCursor && <span className={styles.cursor}>▌</span>}
    </div>
  );
}
