export type MermaidDiagramType =
  | 'flowchart'
  | 'sequence'
  | 'gantt'
  | 'state'
  | 'class'
  | 'er'
  | 'journey'
  | 'pie'
  | 'mindmap'
  | 'gitGraph'
  | 'unknown';

interface MermaidPalette {
  background: string;
  nodeFill: string;
  nodeBorder: string;
  nodeText: string;
  accent: string;
  accentSoft: string;
  secondary: string;
  tertiary: string;
  muted: string;
  line: string;
  clusterFill: string;
  clusterBorder: string;
  edgeLabel: string;
  noteFill: string;
  noteText: string;
}

export interface MermaidVisualConfig {
  startOnLoad: false;
  theme: 'base';
  securityLevel: 'loose';
  fontFamily: string;
  themeVariables: Record<string, string>;
  flowchart?: {
    htmlLabels: boolean;
    curve: 'basis';
    padding: number;
    nodeSpacing: number;
    rankSpacing: number;
  };
  sequence?: {
    mirrorActors: boolean;
    showSequenceNumbers: boolean;
    actorMargin: number;
    messageMargin: number;
    boxMargin: number;
  };
  gantt?: {
    barHeight: number;
    barGap: number;
    topPadding: number;
    leftPadding: number;
    rightPadding: number;
  };
}

const DARK_PALETTE: MermaidPalette = {
  background: 'transparent',
  nodeFill: '#303642',
  nodeBorder: '#7DA0FA',
  nodeText: '#F4F7FB',
  accent: '#7DA0FA',
  accentSoft: '#3A4662',
  secondary: '#8FD17F',
  tertiary: '#4fd7df',
  muted: '#B9C0CC',
  line: '#8A95A8',
  clusterFill: 'rgba(125, 160, 250, 0.08)',
  clusterBorder: 'rgba(125, 160, 250, 0.34)',
  edgeLabel: 'transparent',
  noteFill: '#3A3428',
  noteText: '#F7E3B0',
};

const LIGHT_PALETTE: MermaidPalette = {
  background: 'transparent',
  nodeFill: '#F7F9FC',
  nodeBorder: '#4F6FD7',
  nodeText: '#202635',
  accent: '#4F6FD7',
  accentSoft: '#E9EEFF',
  secondary: '#68AD5B',
  tertiary: '#3bdbcb',
  muted: '#5F6878',
  line: '#697386',
  clusterFill: 'rgba(79, 111, 215, 0.07)',
  clusterBorder: 'rgba(79, 111, 215, 0.26)',
  edgeLabel: 'transparent',
  noteFill: '#FFF6D9',
  noteText: '#3D3421',
};

export function inferMermaidDiagramType(code: string): MermaidDiagramType {
  const firstLine = code
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !line.startsWith('%%'));

  if (!firstLine) return 'unknown';

  if (/^(flowchart|graph)\b/i.test(firstLine)) return 'flowchart';
  if (/^sequenceDiagram\b/i.test(firstLine)) return 'sequence';
  if (/^gantt\b/i.test(firstLine)) return 'gantt';
  if (/^stateDiagram(?:-v2)?\b/i.test(firstLine)) return 'state';
  if (/^classDiagram(?:-v2)?\b/i.test(firstLine)) return 'class';
  if (/^erDiagram\b/i.test(firstLine)) return 'er';
  if (/^journey\b/i.test(firstLine)) return 'journey';
  if (/^pie\b/i.test(firstLine)) return 'pie';
  if (/^mindmap\b/i.test(firstLine)) return 'mindmap';
  if (/^gitGraph\b/i.test(firstLine)) return 'gitGraph';

  return 'unknown';
}

export function buildMermaidVisualConfig(
  dark: boolean,
  diagramType: MermaidDiagramType
): MermaidVisualConfig {
  const palette = dark ? DARK_PALETTE : LIGHT_PALETTE;

  const config: MermaidVisualConfig = {
    startOnLoad: false,
    theme: 'base',
    securityLevel: 'loose',
    fontFamily: 'inherit',
    themeVariables: buildThemeVariables(palette, diagramType),
  };

  if (diagramType === 'flowchart' || diagramType === 'unknown') {
    config.flowchart = {
      htmlLabels: true,
      curve: 'basis',
      padding: 14,
      nodeSpacing: 48,
      rankSpacing: 58,
    };
  }

  if (diagramType === 'sequence') {
    config.sequence = {
      mirrorActors: false,
      showSequenceNumbers: false,
      actorMargin: 52,
      messageMargin: 42,
      boxMargin: 10,
    };
  }

  if (diagramType === 'gantt') {
    config.gantt = {
      barHeight: 20,
      barGap: 6,
      topPadding: 32,
      leftPadding: 78,
      rightPadding: 18,
    };
  }

  return config;
}

export function applyMermaidVisualDirectives(
  code: string,
  diagramType: MermaidDiagramType,
  dark: boolean
): string {
  if (diagramType !== 'flowchart') return code;
  if (/\bclassDef\s+default\b/.test(code) || /\bclassDef\s+/.test(code)) return code;

  const palette = dark ? DARK_PALETTE : LIGHT_PALETTE;

  return `${code.trimEnd()}
classDef default fill:${palette.nodeFill},stroke:${palette.nodeBorder},color:${palette.nodeText},stroke-width:1.2px;
`;
}

export function applyMermaidSvgTextContrast(svg: string): string {
  if (typeof DOMParser === 'undefined' || typeof XMLSerializer === 'undefined') {
    return svg;
  }

  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const parserError = document.querySelector('parsererror');
  if (parserError) return svg;

  for (const node of Array.from(document.querySelectorAll('g.node'))) {
    const fill = findNodeFillColor(node);
    const textColor = getReadableTextColor(fill);
    if (!textColor) continue;

    applyTextColor(node, textColor);
  }

  return new XMLSerializer().serializeToString(document);
}

export function applyMermaidDomTextContrast(root: HTMLElement): void {
  for (const node of Array.from(root.querySelectorAll('g.node'))) {
    const fill = findComputedNodeFillColor(node);
    const textColor = getReadableTextColor(fill);
    if (!textColor) continue;

    applyTextColor(node, textColor);
  }
}

export function getReadableTextColor(fill: string | null): string | null {
  const rgb = parseCssColor(fill);
  if (!rgb) return null;

  const luminance = getRelativeLuminance(rgb);
  return luminance > 0.56 ? '#202635' : '#F4F7FB';
}

/**
 * 为 mindmap 生成 cScale0~11 色阶 + 对应 cScaleLabel 文字色
 *
 * Mermaid mindmap 按分支深度循环使用 cScale 色阶为节点着色。
 * 深色模式色板选用中等亮度饱和色（HSL L 值 35~50%），
 * 浅色模式选用高亮度低饱和色（HSL L 值 85~92%），
 * 确保节点在任意背景上都清晰可辨且色彩丰富。
 */
function buildMindmapColorScale(palette: MermaidPalette): Record<string, string> {
  // 12 色色阶：色相均匀分布，避免相邻色过于接近
  // 深色模式：中亮度饱和色，深色背景上醒目
  // 浅色模式：高亮度柔和色，浅色背景上轻盈
  const isDark = palette.nodeFill === DARK_PALETTE.nodeFill;

  const fills = isDark
    ? [
        '#4A6FA5', // 蓝
        '#6A8A5B', // 绿
        '#8B6BAE', // 紫
        '#B57D5A', // 橙
        '#5B8A8A', // 青
        '#A56B7B', // 玫红
        '#7A8A4A', // 橄榄
        '#6B7AB5', // 靛蓝
        '#B58A5A', // 金
        '#5A7A6B', // 松绿
        '#9A6B9A', // 洋红
        '#6B9A8A', // 薄荷
      ]
    : [
        '#D6E4F0', // 浅蓝
        '#D9EAD3', // 浅绿
        '#E4D6F0', // 浅紫
        '#F0E0D0', // 浅橙
        '#D0EAE8', // 浅青
        '#F0D6DE', // 浅玫红
        '#E4EAD0', // 浅橄榄
        '#D6DAF0', // 浅靛蓝
        '#F0EAD0', // 浅金
        '#D0E8DC', // 浅松绿
        '#EAD6EA', // 浅洋红
        '#D6EAE4', // 浅薄荷
      ];

  // 文字色：深色填充用亮色文字，浅色填充用暗色文字
  const labelColor = isDark ? '#F0F2F6' : '#2A3040';

  const result: Record<string, string> = {};
  for (let i = 0; i < fills.length; i++) {
    const fillColor = fills[i];
    if (!fillColor) continue;
    result[`cScale${i}`] = fillColor;
    result[`cScaleLabel${i}`] = labelColor;
  }

  // 根节点的文字色需要单独设，Mermaid 使用 primaryTextColor
  result['primaryTextColor'] = palette.nodeText;

  return result;
}

function buildThemeVariables(
  palette: MermaidPalette,
  diagramType: MermaidDiagramType
): Record<string, string> {
  const common = {
    background: palette.background,
    mainBkg: palette.nodeFill,
    primaryColor: palette.nodeFill,
    primaryTextColor: palette.nodeText,
    primaryBorderColor: palette.nodeBorder,
    secondaryColor: palette.accentSoft,
    secondaryTextColor: palette.nodeText,
    secondaryBorderColor: palette.secondary,
    tertiaryColor: palette.tertiary,
    tertiaryTextColor: palette.nodeText,
    tertiaryBorderColor: palette.tertiary,
    lineColor: palette.line,
    textColor: palette.nodeText,
    labelTextColor: palette.nodeText,
    edgeLabelBackground: palette.edgeLabel,
    clusterBkg: palette.clusterFill,
    clusterBorder: palette.clusterBorder,
    titleColor: palette.nodeText,
    nodeBorder: palette.nodeBorder,
    noteBkgColor: palette.noteFill,
    noteTextColor: palette.noteText,
    noteBorderColor: palette.tertiary,
    actorBkg: palette.nodeFill,
    actorBorder: palette.nodeBorder,
    actorTextColor: palette.nodeText,
    actorLineColor: palette.line,
    signalColor: palette.line,
    signalTextColor: palette.nodeText,
    labelBoxBkgColor: palette.edgeLabel,
    labelBoxBorderColor: palette.clusterBorder,
    loopTextColor: palette.nodeText,
    activationBkgColor: palette.accentSoft,
    activationBorderColor: palette.nodeBorder,
  };

  if (diagramType === 'gantt') {
    return {
      ...common,
      sectionBkgColor: palette.clusterFill,
      altSectionBkgColor: 'transparent',
      taskBkgColor: palette.accent,
      taskTextColor: palette.nodeText,
      taskTextOutsideColor: palette.muted,
      taskTextLightColor: palette.nodeText,
      taskBorderColor: palette.nodeBorder,
      activeTaskBkgColor: palette.secondary,
      activeTaskBorderColor: palette.secondary,
      doneTaskBkgColor: palette.muted,
      doneTaskBorderColor: palette.muted,
      critBkgColor: palette.tertiary,
      critBorderColor: palette.tertiary,
      gridColor: palette.clusterBorder,
    };
  }

  if (diagramType === 'pie') {
    return {
      ...common,
      pie1: palette.accent,
      pie2: palette.secondary,
      pie3: palette.tertiary,
      pie4: palette.nodeBorder,
      pie5: palette.muted,
      pie6: palette.accentSoft,
    };
  }

  // mindmap 使用独立的 cScale 色阶而非 primaryColor 推导。
  // Mermaid base 主题会从 primaryColor 做亮度推导生成 cScale0~11，
  // 但深色模式的 primaryColor (#303642) 亮度极低，推导出的所有色阶都接近纯黑。
  // 此处直接注入 12 色色阶，跳过自动推导，保证两种模式下都有清晰可辨的多彩节点。
  if (diagramType === 'mindmap') {
    const mindmapScale = buildMindmapColorScale(palette);
    return { ...common, ...mindmapScale };
  }

  return common;
}

function findNodeFillColor(node: Element): string | null {
  const shape = node.querySelector('rect, polygon, circle, ellipse, path');
  if (!shape) return null;

  const styleFill = getStyleValue(shape.getAttribute('style'), 'fill');
  const attrFill = shape.getAttribute('fill');

  return styleFill ?? attrFill;
}

function findComputedNodeFillColor(node: Element): string | null {
  const shape = findNodeShape(node);
  if (!shape) return null;

  const candidates = [
    getStyleValue(shape.getAttribute('style'), 'fill'),
    shape.getAttribute('fill'),
    typeof window === 'undefined' ? null : window.getComputedStyle(shape).fill,
  ];

  return candidates.find((candidate) => parseCssColor(candidate) !== null) ?? null;
}

function findNodeShape(node: Element): Element | null {
  const shapeTags = new Set(['rect', 'polygon', 'circle', 'ellipse', 'path']);
  for (const child of Array.from(node.children)) {
    if (shapeTags.has(child.tagName.toLowerCase())) return child;
  }

  return node.querySelector('rect, polygon, circle, ellipse, path');
}

function applyTextColor(node: Element, color: string): void {
  for (const text of Array.from(node.querySelectorAll('text, tspan'))) {
    text.setAttribute('fill', color);
    setStyleValue(text, 'fill', color);
    setLiveStyleValue(text, 'fill', color);
  }

  for (const label of Array.from(
    node.querySelectorAll('foreignObject, foreignObject *, .nodeLabel')
  )) {
    setStyleValue(label, 'color', color);
    setStyleValue(label, '-webkit-text-fill-color', color);
    setLiveStyleValue(label, 'color', color);
    setLiveStyleValue(label, '-webkit-text-fill-color', color);
  }
}

function getStyleValue(style: string | null, property: string): string | null {
  if (!style) return null;

  for (const declaration of style.split(';')) {
    const [rawName, ...rawValueParts] = declaration.split(':');
    if (!rawName || rawValueParts.length === 0) continue;
    if (rawName.trim().toLowerCase() === property) {
      return rawValueParts.join(':').trim();
    }
  }

  return null;
}

function setStyleValue(element: Element, property: string, value: string): void {
  const declarations = new Map<string, string>();
  const style = element.getAttribute('style');

  if (style) {
    for (const declaration of style.split(';')) {
      const [rawName, ...rawValueParts] = declaration.split(':');
      if (!rawName || rawValueParts.length === 0) continue;
      declarations.set(rawName.trim().toLowerCase(), rawValueParts.join(':').trim());
    }
  }

  declarations.set(property, `${value} !important`);
  element.setAttribute(
    'style',
    Array.from(declarations.entries())
      .map(([name, declarationValue]) => `${name}: ${declarationValue}`)
      .join('; ')
  );
}

function setLiveStyleValue(element: Element, property: string, value: string): void {
  if (!('style' in element)) return;

  const style = (element as HTMLElement | SVGElement).style;
  style.setProperty(property, value, 'important');
}

function parseCssColor(color: string | null): [number, number, number] | null {
  if (!color) return null;

  const normalized = color.trim().toLowerCase();
  if (
    !normalized ||
    normalized === 'none' ||
    normalized === 'transparent' ||
    normalized === 'currentcolor'
  ) {
    return null;
  }

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(normalized);
  if (hex?.[1]) {
    return parseHexColor(hex[1]);
  }

  const rgb = /^rgba?\(([^)]+)\)$/.exec(normalized);
  if (rgb?.[1]) {
    const parts = rgb[1].split(',').map((part) => Number(part.trim()));
    const [r, g, b] = parts;
    if (isColorChannel(r) && isColorChannel(g) && isColorChannel(b)) {
      return [r, g, b];
    }
  }

  return null;
}

function parseHexColor(hex: string): [number, number, number] | null {
  if (hex.length === 3) {
    const [r, g, b] = hex.split('').map((part) => Number.parseInt(part + part, 16));
    if (isColorChannel(r) && isColorChannel(g) && isColorChannel(b)) return [r, g, b];
  }

  if (hex.length === 6) {
    const r = Number.parseInt(hex.slice(0, 2), 16);
    const g = Number.parseInt(hex.slice(2, 4), 16);
    const b = Number.parseInt(hex.slice(4, 6), 16);
    if (isColorChannel(r) && isColorChannel(g) && isColorChannel(b)) return [r, g, b];
  }

  return null;
}

function isColorChannel(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 255;
}

function getRelativeLuminance([r, g, b]: [number, number, number]): number {
  const [linearR, linearG, linearB] = [r, g, b].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * (linearR ?? 0) + 0.7152 * (linearG ?? 0) + 0.0722 * (linearB ?? 0);
}

/**
 * 向 Mermaid 输出的 SVG 注入视觉增强样式
 *
 * 注入位置选择 </svg> 前而非 <svg> 后的原因：
 * 确保我们的规则在 Mermaid 自有 <style> 块之后声明，
 * 同级选择器下后声明的规则优先，无需提高权重。
 *
 * 安全保证：
 * - CSS rx/ry：优先级高于 SVG presentation attribute（如 rx="0"），
 *   浏览器不支持时静默忽略，节点保持直角，不影响渲染。
 * - stroke-linecap/linejoin：Mermaid 不设置此属性，零冲突风险。
 * - 不修改任何颜色属性，themeVariables 的配色完全保留。
 * - 若 SVG 格式异常（找不到 </svg>），原样返回，不破坏显示。
 */
export function injectMermaidSvgStyles(svg: string): string {
  const insertionPoint = svg.lastIndexOf('</svg>');
  // 防御：SVG 格式异常时原样返回，不引入渲染失败
  if (insertionPoint === -1) return svg;

  const rules: string[] = [
    // ── 通用规则（所有图表类型共享）──
    // 节点矩形圆角：CSS 优先级高于 SVG presentation attribute rx="0"，无需 !important
    '.node rect { rx: 6; ry: 6; }',
    // subgraph 集群容器圆角略大，视觉上区分容器与节点层级
    '.cluster rect { rx: 8; ry: 8; }',
    // 序列图 actor 方框圆角
    '.actor rect { rx: 6; ry: 6; }',
    // 连线端点与转折点圆滑，消除直角折线的锯齿感
    '.edgePath path, .messageLine0, .messageLine1, .relation { stroke-linecap: round; stroke-linejoin: round; }',
    // 箭头标记末端也圆滑，与连线风格统一
    'marker path { stroke-linecap: round; }',
  ];

  // ── mindmap 专用规则 ──
  // 通过检测 Mermaid mindmap 生成的特征 CSS class（section-0）来判断图表类型，
  // 避免修改函数签名或影响其他图表类型
  if (isMindmapSvg(svg)) {
    rules.push(
      // 连线加粗：默认 1px 在思维导图中太细，加粗后视觉重量更均衡
      '.edge path { stroke-width: 2.2px; }',
      // 连线半透明：降低连线视觉优先级，让节点内容成为焦点
      '.edge path { opacity: 0.6; }',
      // 连线端点圆滑
      '.edge path { stroke-linecap: round; stroke-linejoin: round; }',
      // mindmap 节点边框也圆滑化
      '.mindmap-node rect, .mindmap-node circle, .mindmap-node polygon { stroke-linejoin: round; }'
    );
  }

  const style = '<style>' + rules.join('') + '</style>';
  return svg.slice(0, insertionPoint) + style + svg.slice(insertionPoint);
}

/**
 * 判断 SVG 是否由 Mermaid mindmap 渲染器生成
 *
 * Mermaid mindmap 为每个分支层级的节点添加 section-N class（如 section-0, section-1），
 * 这是 mindmap 独有的特征，flowchart/sequence/gantt 等均不使用此命名。
 */
function isMindmapSvg(svg: string): boolean {
  return svg.includes('section-0');
}
