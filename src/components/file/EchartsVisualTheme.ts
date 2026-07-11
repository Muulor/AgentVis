import type { EChartsOption } from 'echarts';

type AnyRecord = Record<string, unknown>;

export type ChartVisualPreset =
  | 'analyticalDark'
  | 'cleanLight'
  | 'financialWarm'
  | 'presentationSoft'
  | 'contrastBusiness';

export interface SafeEChartsVisualOptions {
  dark: boolean;
  enableVisualTheme?: boolean;
}

interface ChartVisualTheme {
  colors: string[];
  axisLabel: string;
  axisLine: string;
  splitLine: string;
  title: string;
  muted: string;
  tooltipBackground: string;
  tooltipBorder: string;
  sliceBorder: string;
  barGradients: [string, string][];
  areaOpacity: number;
  radarAreaOpacity: number;
}

const SUPPORTED_SERIES_TYPES = new Set([
  'bar',
  'line',
  'pie',
  'scatter',
  'radar',
  'gauge',
  'funnel',
  'heatmap',
]);

const RISKY_OPTION_KEYS = new Set([
  'graphic',
  'geo',
  'map',
  'calendar',
  'parallel',
  'singleAxis',
  'timeline',
  'mapbox',
]);

const APP_CHART_COLORS = [
  '#3F7BD9',
  '#7CB342',
  '#E0A238',
  '#4ba1c9',
  '#E34F53',
  '#7E57C2',
  '#E27A3A',
  '#21804E',
  '#ff9090',
  '#6da7e1',
  '#4a8131',
  '#7D8BF4',
];

const APP_CHART_BAR_GRADIENTS: [string, string][] = [
  ['#679aed', '#3F7BD9'],
  ['#94c85f', '#7CB342'],
  ['#efb64d', '#E0A238'],
  ['#72badb', '#4ba1c9'],
  ['#f37477', '#E34F53'],
  ['#9b72df', '#7E57C2'],
  ['#ed975f', '#E27A3A'],
  ['#3a9b68', '#21804E'],
  ['#ffb1b1', '#ff9090'],
  ['#93c5fd', '#6da7e1'],
  ['#6b9a4d', '#4a8131'],
  ['#98a3ff', '#7D8BF4'],
];

const VISUAL_PRESETS: Record<ChartVisualPreset, ChartVisualTheme> = {
  analyticalDark: {
    colors: APP_CHART_COLORS,
    axisLabel: 'rgba(235, 238, 245, 0.72)',
    axisLine: 'rgba(235, 238, 245, 0.32)',
    splitLine: 'rgba(235, 238, 245, 0.10)',
    title: 'rgba(248, 250, 252, 0.92)',
    muted: 'rgba(235, 238, 245, 0.62)',
    tooltipBackground: 'rgba(31, 34, 40, 0.94)',
    tooltipBorder: 'rgba(255, 255, 255, 0.12)',
    sliceBorder: 'rgba(30, 32, 36, 0.96)',
    barGradients: APP_CHART_BAR_GRADIENTS,
    // 深色背景对比度低，面积填充需更高不透明度才能有效感知
    areaOpacity: 0.26,
    radarAreaOpacity: 0.15,
  },
  cleanLight: {
    colors: APP_CHART_COLORS,
    axisLabel: 'rgba(42, 47, 58, 0.68)',
    axisLine: 'rgba(42, 47, 58, 0.18)',
    splitLine: 'rgba(42, 47, 58, 0.08)',
    title: 'rgba(28, 32, 40, 0.90)',
    muted: 'rgba(42, 47, 58, 0.58)',
    tooltipBackground: 'rgba(255, 255, 255, 0.96)',
    tooltipBorder: 'rgba(42, 47, 58, 0.12)',
    sliceBorder: '#ffffff',
    barGradients: APP_CHART_BAR_GRADIENTS,
    // 浅色背景明亮，面积填充需克制以免喧宾夺主
    areaOpacity: 0.1,
    radarAreaOpacity: 0.06,
  },
  financialWarm: {
    colors: APP_CHART_COLORS,
    axisLabel: 'rgba(238, 232, 222, 0.74)',
    axisLine: 'rgba(238, 232, 222, 0.26)',
    splitLine: 'rgba(238, 232, 222, 0.09)',
    title: 'rgba(250, 246, 240, 0.92)',
    muted: 'rgba(238, 232, 222, 0.62)',
    tooltipBackground: 'rgba(43, 40, 36, 0.94)',
    tooltipBorder: 'rgba(226, 184, 120, 0.28)',
    sliceBorder: 'rgba(42, 39, 35, 0.96)',
    barGradients: APP_CHART_BAR_GRADIENTS,
    // 暖金色深色背景，适当提升面积可读性
    areaOpacity: 0.25,
    radarAreaOpacity: 0.14,
  },
  presentationSoft: {
    colors: APP_CHART_COLORS,
    axisLabel: 'rgba(44, 49, 60, 0.66)',
    axisLine: 'rgba(44, 49, 60, 0.16)',
    splitLine: 'rgba(44, 49, 60, 0.07)',
    title: 'rgba(30, 35, 44, 0.88)',
    muted: 'rgba(44, 49, 60, 0.56)',
    tooltipBackground: 'rgba(255, 255, 255, 0.97)',
    tooltipBorder: 'rgba(44, 49, 60, 0.10)',
    sliceBorder: '#ffffff',
    barGradients: APP_CHART_BAR_GRADIENTS,
    areaOpacity: 0.09,
    radarAreaOpacity: 0.05,
  },
  contrastBusiness: {
    colors: APP_CHART_COLORS,
    axisLabel: 'rgba(32, 37, 48, 0.70)',
    axisLine: 'rgba(32, 37, 48, 0.20)',
    splitLine: 'rgba(32, 37, 48, 0.09)',
    title: 'rgba(24, 28, 36, 0.92)',
    muted: 'rgba(32, 37, 48, 0.60)',
    tooltipBackground: 'rgba(255, 255, 255, 0.98)',
    tooltipBorder: 'rgba(32, 37, 48, 0.14)',
    sliceBorder: '#ffffff',
    barGradients: APP_CHART_BAR_GRADIENTS,
    areaOpacity: 0.09,
    radarAreaOpacity: 0.05,
  },
};

export function buildSafeEChartsOption(
  source: EChartsOption,
  options: SafeEChartsVisualOptions
): EChartsOption {
  const option = clonePlainOption(source);
  stripRiskyFields(option);
  normalizeTitle(option);
  normalizeSeries(option);

  const preset = resolvePreset(option, options.dark);
  const theme = VISUAL_PRESETS[preset];

  option.backgroundColor = 'transparent';
  option.color =
    Array.isArray(option.color) && option.color.length > 0 ? option.color : theme.colors;
  applyBasicDefaults(option, theme);

  if (options.enableVisualTheme !== false) {
    applyVisualRecipes(option, theme);
  }

  // 动画配置在所有 recipe 之后注入，作为全局兜底
  applyAnimationDefaults(option);

  return option as EChartsOption;
}

function clonePlainOption(source: EChartsOption): AnyRecord {
  return JSON.parse(JSON.stringify(source)) as AnyRecord;
}

function isPlainRecord(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripRiskyFields(value: unknown, parentKey?: string): void {
  if (Array.isArray(value)) {
    for (const item of value) stripRiskyFields(item, parentKey);
    return;
  }

  if (!isPlainRecord(value)) return;

  for (const key of Object.keys(value)) {
    if (
      RISKY_OPTION_KEYS.has(key) ||
      key === 'renderItem' ||
      (parentKey === 'dataset' && key === 'transform')
    ) {
      Reflect.deleteProperty(value, key);
      continue;
    }

    stripRiskyFields(value[key], key);
  }
}

function normalizeSeries(option: AnyRecord): void {
  const series = option.series;
  if (!series) return;

  const seriesList = Array.isArray(series) ? series : [series];
  const normalized = seriesList.filter((item): item is AnyRecord => {
    if (!isPlainRecord(item)) return false;
    const type = item.type;
    return typeof type === 'string' && SUPPORTED_SERIES_TYPES.has(type);
  });

  option.series = normalized;
}

function normalizeTitle(option: AnyRecord): void {
  const title = option.title;

  if (typeof title === 'string') {
    const text = title.trim();
    if (text) {
      option.title = { text };
    } else {
      Reflect.deleteProperty(option, 'title');
    }
    return;
  }

  if (!Array.isArray(title)) return;

  const normalized = title
    .map((item): unknown => {
      if (typeof item === 'string') {
        const text = item.trim();
        return text ? { text } : null;
      }
      return item;
    })
    .filter((item): item is AnyRecord => isPlainRecord(item));

  option.title = normalized;
}

function resolvePreset(option: AnyRecord, dark: boolean): ChartVisualPreset {
  const rawPreset = option.__visualPreset;
  Reflect.deleteProperty(option, '__visualPreset');

  if (typeof rawPreset === 'string' && rawPreset in VISUAL_PRESETS) {
    return rawPreset as ChartVisualPreset;
  }

  return dark ? 'analyticalDark' : 'cleanLight';
}

function applyBasicDefaults(option: AnyRecord, theme: ChartVisualTheme): void {
  const seriesTypes = getSeriesTypes(option);
  const hasCartesianSeries = ['bar', 'line', 'scatter', 'heatmap'].some((type) =>
    seriesTypes.has(type)
  );

  option.tooltip = mergeDefaults(asRecord(option.tooltip), {
    trigger: seriesTypes.has('pie') || seriesTypes.has('funnel') ? 'item' : 'axis',
    backgroundColor: theme.tooltipBackground,
    borderColor: theme.tooltipBorder,
    borderWidth: 1,
    textStyle: { color: theme.title, fontSize: 12 },
    confine: true,
    // 玻璃质感：圆角 + 多层阴影，与现代深色 UI 风格保持一致
    extraCssText:
      'border-radius: 8px; box-shadow: 0 4px 24px rgba(0,0,0,0.22), 0 1px 4px rgba(0,0,0,0.12);',
  });

  applyTitleDefaults(option, theme);
  applyLegendDefaults(option, theme, seriesTypes);

  if (hasCartesianSeries) {
    ensureCartesianAxes(option);
    option.grid = mergeDefaults(asRecord(option.grid), {
      left: 12,
      right: 18,
      top: option.title ? 44 : 28,
      bottom: option.legend ? 52 : 32,
      containLabel: true,
    });
    applyAxisDefaults(option, 'xAxis', theme);
    applyAxisDefaults(option, 'yAxis', theme);
  }
}

function ensureCartesianAxes(option: AnyRecord): void {
  const hasXAxis = option.xAxis !== undefined;
  const hasYAxis = option.yAxis !== undefined;

  if (hasXAxis && !hasYAxis) {
    option.yAxis = { type: 'value' };
  } else if (!hasXAxis && hasYAxis) {
    option.xAxis = { type: 'value' };
  }
}

function applyTitleDefaults(option: AnyRecord, theme: ChartVisualTheme): void {
  if (!option.title) return;

  const titles = Array.isArray(option.title) ? option.title : [option.title];
  for (const title of titles) {
    if (!isPlainRecord(title)) continue;
    title.left = title.left ?? 'center';
    title.top = title.top ?? 0;
    title.textStyle = mergeDefaults(asRecord(title.textStyle), {
      color: theme.title,
      fontSize: 15,
      fontWeight: 600,
    });
    title.subtextStyle = mergeDefaults(asRecord(title.subtextStyle), {
      color: theme.muted,
      fontSize: 11,
    });
  }
}

function applyLegendDefaults(
  option: AnyRecord,
  theme: ChartVisualTheme,
  seriesTypes: Set<string>
): void {
  const series = getSeriesList(option);
  const shouldShowLegend =
    series.length > 1 ||
    seriesTypes.has('pie') ||
    seriesTypes.has('funnel') ||
    series.some((item) => typeof item.name === 'string' && item.name.length > 0);

  if (!shouldShowLegend || option.legend === false) return;

  option.legend = mergeDefaults(asRecord(option.legend), {
    bottom: 0,
    left: 'center',
    itemWidth: 10,
    itemHeight: 10,
    itemGap: 14,
    textStyle: { color: theme.muted, fontSize: 12 },
  });
}

function applyAxisDefaults(
  option: AnyRecord,
  key: 'xAxis' | 'yAxis',
  theme: ChartVisualTheme
): void {
  const axis = option[key];
  if (!axis) return;

  const axes = Array.isArray(axis) ? axis : [axis];
  for (const item of axes) {
    if (!isPlainRecord(item)) continue;
    const isValueAxis =
      item.type === 'value' || item.type === 'log' || (!item.type && key === 'yAxis');

    item.axisTick = mergeDefaults(asRecord(item.axisTick), { show: false });
    item.axisLine = mergeDefaults(asRecord(item.axisLine), {
      lineStyle: { color: theme.axisLine },
    });
    item.axisLabel = mergeDefaults(asRecord(item.axisLabel), {
      color: theme.axisLabel,
      fontSize: 12,
      margin: 10,
    });
    item.splitLine = mergeDefaults(asRecord(item.splitLine), {
      show: isValueAxis,
      lineStyle: { color: theme.splitLine, type: 'dashed' },
    });
  }
}

function applyVisualRecipes(option: AnyRecord, theme: ChartVisualTheme): void {
  for (const [index, series] of getSeriesList(option).entries()) {
    const type = series.type;

    if (type === 'bar') applyBarRecipe(series, theme, index);
    else if (type === 'line') applyLineRecipe(series, theme, index);
    else if (type === 'pie') applyPieRecipe(series, theme);
    else if (type === 'scatter') applyScatterRecipe(series, theme);
    else if (type === 'radar') applyRadarSeriesRecipe(series, theme, index);
    else if (type === 'gauge') applyGaugeRecipe(series, theme);
    else if (type === 'funnel') applyFunnelRecipe(series, theme);
    else if (type === 'heatmap') applyHeatmapRecipe(option, series, theme);
  }

  applyRadarOptionRecipe(option, theme);
}

function applyBarRecipe(series: AnyRecord, theme: ChartVisualTheme, index: number): void {
  series.barMaxWidth = series.barMaxWidth ?? 51;
  series.barMinHeight = series.barMinHeight ?? 2;
  // 多系列柱状图按索引错开进场，形成渐次展开的视觉节奏
  series.animationDelay = series.animationDelay ?? index * 120;
  series.itemStyle = mergeDefaults(asRecord(series.itemStyle), {
    borderRadius: [5, 5, 2, 2],
    color: makeLinearGradient(pickGradient(theme, index)),
  });
  series.emphasis = mergeDefaults(asRecord(series.emphasis), {
    focus: 'series',
    itemStyle: {
      opacity: 0.92,
      // hover 时添加下沉阴影，强化交互悬停反馈
      shadowBlur: 12,
      shadowColor: 'rgba(0, 0, 0, 0.28)',
    },
  });
}

function applyLineRecipe(series: AnyRecord, theme: ChartVisualTheme, index: number): void {
  const color = pickColor(theme, index);
  // 多折线按索引错开进场，视觉上依次绘入而非同时弹出
  series.animationDelay = series.animationDelay ?? index * 120;
  series.smooth = series.smooth ?? true;
  series.symbol = series.symbol ?? 'circle';
  series.symbolSize = series.symbolSize ?? 6;
  series.lineStyle = mergeDefaults(asRecord(series.lineStyle), {
    width: 2.5,
    color,
  });
  series.itemStyle = mergeDefaults(asRecord(series.itemStyle), {
    color,
    borderWidth: 2,
    borderColor: '#ffffff',
  });
  series.areaStyle = mergeDefaults(asRecord(series.areaStyle), {
    opacity: theme.areaOpacity,
    color: makeAreaGradient(color),
  });
  series.emphasis = mergeDefaults(asRecord(series.emphasis), {
    focus: 'series',
    // hover 时线条加粗并产生同色发光，强化数据系列的选中感
    lineStyle: {
      width: 3.5,
      shadowBlur: 10,
      shadowColor: color,
    },
  });
}

function applyPieRecipe(series: AnyRecord, theme: ChartVisualTheme): void {
  series.radius = series.radius ?? ['46%', '70%'];
  series.center = series.center ?? ['50%', '52%'];
  series.avoidLabelOverlap = series.avoidLabelOverlap ?? true;
  series.itemStyle = mergeDefaults(asRecord(series.itemStyle), {
    borderRadius: 6,
    borderWidth: 3,
  });
  // 透明包边是 UI 层面的一致性决策，必须强制覆盖 LLM 可能设置的任何 borderColor，
  // 确保切片间缝隙露出气泡背景色，在深色/浅色主题下都自然融合
  const itemStyle = asRecord(series.itemStyle);
  itemStyle.borderColor = 'transparent';
  series.label = mergeDefaults(asRecord(series.label), {
    color: theme.title,
    fontSize: 12,
  });
  series.labelLine = mergeDefaults(asRecord(series.labelLine), {
    length: 14,
    length2: 10,
    lineStyle: { color: theme.axisLine },
  });
  series.emphasis = mergeDefaults(asRecord(series.emphasis), {
    scale: true,
    scaleSize: 8,
    // 较强阴影让 hover 切片产生悬浮脱离效果
    itemStyle: { shadowBlur: 22, shadowColor: 'rgba(0, 0, 0, 0.32)' },
  });
}

function applyScatterRecipe(series: AnyRecord, theme: ChartVisualTheme): void {
  series.symbolSize = series.symbolSize ?? 10;
  series.itemStyle = mergeDefaults(asRecord(series.itemStyle), {
    opacity: 0.82,
    borderWidth: 1.5,
    borderColor: theme.sliceBorder,
  });
  series.emphasis = mergeDefaults(asRecord(series.emphasis), {
    focus: 'series',
    scale: true,
    itemStyle: {
      opacity: 1,
      shadowBlur: 10,
      shadowColor: 'rgba(0, 0, 0, 0.25)',
    },
  });
}

function applyRadarSeriesRecipe(series: AnyRecord, theme: ChartVisualTheme, index: number): void {
  const color = pickColor(theme, index);
  series.symbolSize = series.symbolSize ?? 4;
  series.lineStyle = mergeDefaults(asRecord(series.lineStyle), { width: 2, color });
  series.areaStyle = mergeDefaults(asRecord(series.areaStyle), {
    opacity: theme.radarAreaOpacity,
    color,
  });
  series.itemStyle = mergeDefaults(asRecord(series.itemStyle), { color });

  if (!Array.isArray(series.data)) return;

  for (const [dataIndex, item] of series.data.entries()) {
    if (!isPlainRecord(item)) continue;

    const itemColor = pickColor(theme, dataIndex);
    item.lineStyle = mergeDefaults(asRecord(item.lineStyle), {
      width: 2.25,
      color: itemColor,
    });
    item.areaStyle = mergeDefaults(asRecord(item.areaStyle), {
      opacity: theme.radarAreaOpacity,
      color: itemColor,
    });
    item.itemStyle = mergeDefaults(asRecord(item.itemStyle), {
      color: itemColor,
      borderWidth: 1,
    });
  }
}

function applyRadarOptionRecipe(option: AnyRecord, theme: ChartVisualTheme): void {
  if (!option.radar) return;

  const radars = Array.isArray(option.radar) ? option.radar : [option.radar];
  for (const radar of radars) {
    if (!isPlainRecord(radar)) continue;
    radar.axisName = mergeDefaults(asRecord(radar.axisName), {
      color: theme.axisLabel,
      fontSize: 12,
    });
    radar.axisLine = mergeDefaults(asRecord(radar.axisLine), {
      lineStyle: { color: theme.axisLine },
    });
    radar.splitLine = mergeDefaults(asRecord(radar.splitLine), {
      lineStyle: { color: theme.splitLine },
    });
    radar.splitArea = mergeDefaults(asRecord(radar.splitArea), {
      areaStyle: { color: ['rgba(255,255,255,0.02)', 'rgba(255,255,255,0.00)'] },
    });
  }
}

function applyGaugeRecipe(series: AnyRecord, theme: ChartVisualTheme): void {
  const primaryColor = theme.colors[0] ?? '#E34F53';
  series.radius = series.radius ?? '84%';

  // 细长发光指针：同色 + shadowBlur，比传统粗指针更轻盈，
  // 保留仪表盘最核心的「指向性」视觉语义
  series.pointer = mergeDefaults(asRecord(series.pointer), {
    show: true,
    length: '65%',
    width: 4,
    itemStyle: {
      color: primaryColor,
      shadowBlur: 8,
      shadowColor: primaryColor + '88',
    },
  });
  series.progress = mergeDefaults(asRecord(series.progress), {
    show: true,
    width: 14,
    itemStyle: {
      shadowBlur: 8,
      shadowColor: primaryColor + 'aa',
    },
  });
  series.axisLine = mergeDefaults(asRecord(series.axisLine), {
    lineStyle: { width: 14, color: [[1, 'rgba(148, 163, 184, 0.15)']] },
  });
  series.axisTick = mergeDefaults(asRecord(series.axisTick), { show: false });
  series.splitLine = mergeDefaults(asRecord(series.splitLine), { show: false });
  series.axisLabel = mergeDefaults(asRecord(series.axisLabel), { show: false });

  // detail（数值）放在中心偏下，title（标签名）放在中心偏上（负值 = 向上）
  // 两者方向相反，在弧内上下分布，彻底消除重叠
  series.detail = mergeDefaults(asRecord(series.detail), {
    color: theme.title,
    fontSize: 22,
    fontWeight: 700,
    offsetCenter: [0, '55%'],
  });
  series.title = mergeDefaults(asRecord(series.title), {
    color: theme.muted,
    fontSize: 13,
    offsetCenter: [0, '-35%'],
  });
}

function applyFunnelRecipe(series: AnyRecord, theme: ChartVisualTheme): void {
  series.gap = series.gap ?? 3;
  series.itemStyle = mergeDefaults(asRecord(series.itemStyle), {
    borderColor: theme.sliceBorder,
    borderWidth: 1,
  });
  series.label = mergeDefaults(asRecord(series.label), { color: theme.title, fontSize: 12 });
  series.emphasis = mergeDefaults(asRecord(series.emphasis), { focus: 'series' });
}

function applyHeatmapRecipe(option: AnyRecord, series: AnyRecord, theme: ChartVisualTheme): void {
  series.itemStyle = mergeDefaults(asRecord(series.itemStyle), {
    borderWidth: 1,
    borderColor: theme.sliceBorder,
  });

  option.visualMap ??= {
    min: 0,
    calculable: true,
    orient: 'horizontal',
    left: 'center',
    bottom: 0,
    textStyle: { color: theme.muted },
    inRange: { color: [pickColor(theme, 3), pickColor(theme, 7), pickColor(theme, 0)] },
  };
}

function getSeriesTypes(option: AnyRecord): Set<string> {
  const types = new Set<string>();
  for (const series of getSeriesList(option)) {
    if (typeof series.type === 'string') types.add(series.type);
  }
  return types;
}

function getSeriesList(option: AnyRecord): AnyRecord[] {
  if (!Array.isArray(option.series)) return [];
  return option.series.filter(isPlainRecord);
}

function asRecord(value: unknown): AnyRecord {
  return isPlainRecord(value) ? value : {};
}

function mergeDefaults(target: AnyRecord, defaults: AnyRecord): AnyRecord {
  for (const [key, value] of Object.entries(defaults)) {
    if (target[key] === undefined) {
      target[key] = value;
    } else if (isPlainRecord(target[key]) && isPlainRecord(value)) {
      mergeDefaults(target[key], value);
    }
  }

  return target;
}

function pickColor(theme: ChartVisualTheme, index: number): string {
  return theme.colors[index % theme.colors.length] ?? '#E34F53';
}

function pickGradient(theme: ChartVisualTheme, index: number): [string, string] {
  return theme.barGradients[index % theme.barGradients.length] ?? ['#f37477', '#E34F53'];
}

function makeLinearGradient(colors: [string, string]): AnyRecord {
  return {
    type: 'linear',
    x: 0,
    y: 0,
    x2: 0,
    y2: 1,
    colorStops: [
      { offset: 0, color: colors[0] },
      { offset: 1, color: colors[1] },
    ],
  };
}

/**
 * 将 #RRGGBB 色值转为等色相的透明版本
 */
function colorToTransparent(color: string): string {
  if (color.startsWith('#') && color.length === 7) {
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, 0)`;
  }
  if (color.startsWith('rgba(')) {
    return color.replace(/,\s*[\d.]+\)$/, ', 0)');
  }
  if (color.startsWith('rgb(')) {
    return color.replace('rgb(', 'rgba(').replace(')', ', 0)');
  }
  return 'rgba(0, 0, 0, 0)';
}

function makeAreaGradient(color: string): AnyRecord {
  return {
    type: 'linear',
    x: 0,
    y: 0,
    x2: 0,
    y2: 1,
    colorStops: [
      { offset: 0, color },
      // 使用同色相透明色作为渐变终点，避免深色背景下的白边光晕
      { offset: 1, color: colorToTransparent(color) },
    ],
  };
}

/**
 * 注入全局动画配置
 *
 * 采用 cubicOut 缓动（快入慢出）而非线性动画，符合物理直觉，视觉更自然。
 * LLM 几乎不会在 option 中指定动画参数，mergeDefaults 此处等价于强制注入。
 */
function applyAnimationDefaults(option: AnyRecord): void {
  option.animationDuration = option.animationDuration ?? 900;
  option.animationEasing = option.animationEasing ?? 'cubicOut';
  option.animationDurationUpdate = option.animationDurationUpdate ?? 600;
  option.animationEasingUpdate = option.animationEasingUpdate ?? 'cubicInOut';
}
