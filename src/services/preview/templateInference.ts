/**
 * templateInference - 统一模板推断逻辑
 *
 * 将分散在 MessageBubble、FileList、FilePreview 中的
 * 模板推断逻辑统一到服务层，避免 3 处重复实现。
 *
 * 推断策略（优先级从高到低）：
 * 1. 存在 JSX/TSX 文件 → react-tailwind
 * 2. 存在 .vue 文件 → vue-tailwind
 * 3. 其他 → vanilla
 */

import type { TemplateId } from './types';

/** 可项目预览的文件扩展名集合 */
export const PREVIEWABLE_EXTENSIONS = new Set([
    'jsx', 'tsx', 'js', 'ts', 'css', 'vue', 'html',
]);

/**
 * 判断文件名是否为可项目预览的类型
 */
export function isPreviewableFile(fileName: string): boolean {
    const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
    return PREVIEWABLE_EXTENSIONS.has(ext);
}

/**
 * 根据单个文件名推断模板
 *
 * 用于文件预览（FilePreview）和代码块预览（CodeHighlight）场景。
 */
export function inferTemplateFromFileName(fileName: string): TemplateId {
    const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
    if (ext === 'jsx' || ext === 'tsx') return 'react-tailwind';
    if (ext === 'vue') return 'vue-tailwind';
    return 'vanilla';
}

/**
 * 根据多个文件名推断模板
 *
 * 用于交付物文件夹（FileList）和多文件代码块（MessageBubble）场景。
 */
export function inferTemplateFromFileNames(fileNames: string[]): TemplateId {
    const hasReact = fileNames.some(name => {
        const ext = name.split('.').pop()?.toLowerCase() ?? '';
        return ext === 'jsx' || ext === 'tsx';
    });
    if (hasReact) return 'react-tailwind';

    const hasVue = fileNames.some(name => {
        const ext = name.split('.').pop()?.toLowerCase() ?? '';
        return ext === 'vue';
    });
    if (hasVue) return 'vue-tailwind';

    return 'vanilla';
}

/**
 * 根据代码块语言推断模板
 *
 * 用于单个代码块预览（MessageBubble handleProjectPreview）场景。
 */
export function inferTemplateFromLanguage(language: string): TemplateId {
    if (language === 'jsx' || language === 'tsx') return 'react-tailwind';
    if (language === 'vue') return 'vue-tailwind';
    return 'vanilla';
}

/**
 * 根据多个代码块语言推断模板
 *
 * 用于多文件预览（MessageBubble handleMultiFilePreview）场景。
 */
export function inferTemplateFromLanguages(languages: string[]): TemplateId {
    if (languages.some(l => l === 'jsx' || l === 'tsx')) return 'react-tailwind';
    if (languages.some(l => l === 'vue')) return 'vue-tailwind';
    return 'vanilla';
}

/**
 * 将 SVG 代码包裹在 HTML 文档中
 *
 * iframe srcdoc 无法直接渲染裸 SVG，需要包一层 HTML 外壳。
 * 深色背景 + 居中显示 + SVG 自适应宽度，匹配应用整体风格。
 */
export function wrapSvgInHtml(svgCode: string): string {
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #1a1a2e;
    padding: 16px;
  }
  svg {
    max-width: 100%;
    height: auto;
  }
</style>
</head>
<body>
${svgCode}
</body>
</html>`;
}
