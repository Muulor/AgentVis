/**
 * JsonParser 单元测试
 *
 * 重点测试 extractJsonFromText 的围栏解析鲁棒性——
 * 当 JSON 字符串值中包含 ``` markdown 代码块时，
 * 不应被误识别为围栏结束标记
 */

import { describe, it, expect } from 'vitest';
import { extractJsonFromText, parseWithFallback } from '../JsonParser';

// ==================== extractJsonFromText ====================

describe('extractJsonFromText', () => {
  describe('策略1: 纯 JSON', () => {
    it('应提取纯 JSON 对象', () => {
      const input = '{"decision": "APPROVE", "rationale": "ok"}';
      expect(extractJsonFromText(input)).toBe(input);
    });

    it('应提取纯 JSON 数组', () => {
      const input = '[1, 2, 3]';
      expect(extractJsonFromText(input)).toBe(input);
    });
  });

  describe('策略2: Markdown 围栏', () => {
    it('标准 ```json 围栏应正常提取', () => {
      const input = '```json\n{"a": 1}\n```';
      const result = extractJsonFromText(input);
      expect(result).toBe('{"a": 1}');
    });

    it('无 json 标记的 ``` 围栏也应正常提取', () => {
      const input = '```\n{"a": 1}\n```';
      const result = extractJsonFromText(input);
      expect(result).toBe('{"a": 1}');
    });

    it('未闭合的围栏应取全部剩余内容', () => {
      const input = '```json\n{"a": 1, "b": 2}';
      const result = extractJsonFromText(input);
      expect(result).toBe('{"a": 1, "b": 2}');
    });

    // ============ 核心修复场景 ============

    it('JSON 字符串值中包含 ``` 时不应提前截断', () => {
      // 这是真实失败场景的简化版：
      // task 字段包含 markdown 代码块，导致围栏被提前关闭
      const innerJson = JSON.stringify({
        decision: 'SPAWN_SUB_AGENT',
        nextStep: {
          task: '替换为：\n```\n新内容\n```\n然后保存',
          tools: ['read', 'file_write'],
        },
      });

      const input = '```json\n' + innerJson + '\n```';
      const result = extractJsonFromText(input);

      // 验证提取到了完整的 JSON
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result!);
      expect(parsed.decision).toBe('SPAWN_SUB_AGENT');
      expect(parsed.nextStep.tools).toEqual(['read', 'file_write']);
    });

    it('多个 ``` 嵌套时应匹配正确的围栏结束', () => {
      const innerJson = JSON.stringify({
        response: '代码如下：\n```python\nprint("hello")\n```\n以上是示例',
      });

      const input = '```json\n' + innerJson + '\n```';
      const result = extractJsonFromText(input);

      expect(result).not.toBeNull();
      const parsed = JSON.parse(result!);
      expect(parsed.response).toContain('python');
    });

    it('真实日志场景：RESPOND_TO_USER 含 markdown 代码块', () => {
      // 模拟真实日志 line 201-218 的场景
      const innerJson = JSON.stringify({
        decision: 'RESPOND_TO_USER',
        rationale: '任务已完成',
        riskAssessment: { level: 'low', notes: '无风险' },
        response: '修改完成：\n```\n从**纯行动**层面...\n```\n已验证',
      });

      const input = '```json\n' + innerJson + '\n```';
      const result = extractJsonFromText(input);

      expect(result).not.toBeNull();
      const parsed = JSON.parse(result!);
      expect(parsed.decision).toBe('RESPOND_TO_USER');
      expect(parsed.response).toContain('纯行动');
    });

    it('围栏内无 JSON 开头应返回 null 并回退到后续策略', () => {
      const input = '```\nsome plain text\n```';
      // 策略2 无法提取（不以 { 或 [ 开头），会回退
      const result = extractJsonFromText(input);
      expect(result).toBeNull();
    });
  });

  describe('策略3: 前缀文本 + JSON', () => {
    it('thought 前缀后的 JSON 应正常提取', () => {
      const input = 'thought: 我需要分析\n{"decision": "DENY"}';
      const result = extractJsonFromText(input);
      expect(result).toBe('{"decision": "DENY"}');
    });
  });

  describe('策略4: 混合文本中的 JSON', () => {
    it('混合文本中应提取第一个 JSON', () => {
      const input = '分析结果如下 {"a": 1} 结束';
      const result = extractJsonFromText(input);
      expect(result).toBe('{"a": 1}');
    });
  });
});

// ==================== parseWithFallback ====================

describe('parseWithFallback', () => {
  it('围栏包含内嵌 ``` 时应正确解析', () => {
    const obj = {
      decision: 'SPAWN_SUB_AGENT',
      nextStep: {
        task: '步骤：\n```\n代码内容\n```\n完成',
      },
    };
    const input = '```json\n' + JSON.stringify(obj) + '\n```';
    const result = parseWithFallback<typeof obj>(input);

    expect(result.success).toBe(true);
    expect(result.data?.decision).toBe('SPAWN_SUB_AGENT');
    expect(result.data?.nextStep.task).toContain('代码内容');
  });

  it('无内嵌 ``` 的标准围栏应正确解析', () => {
    const input = '```json\n{"key": "value"}\n```';
    const result = parseWithFallback<Record<string, string>>(input);

    expect(result.success).toBe(true);
    expect(result.data?.key).toBe('value');
  });

  it('repairs a complete fenced JSON root followed by an extra closing brace', () => {
    const input = '```json\n{"key": "value"}\n}\n```';
    const result = parseWithFallback<Record<string, string>>(input);

    expect(result.success).toBe(true);
    expect(result.strategy).toBe('balanced-root-prefix');
    expect(result.data?.key).toBe('value');
  });

  it('does not discard non-structural text after a fenced JSON root', () => {
    const input = '```json\n{"key": "value"}\nextra explanation\n```';
    const result = parseWithFallback<Record<string, string>>(input, { suppressWarnings: true });

    expect(result.success).toBe(false);
  });

  it('task 字段含未转义换行和内嵌围栏时应通过 sanitize 修复后解析', () => {
    // 模拟真实 LLM 输出：task 值包含真实换行符（非 \\n）和 markdown 围栏
    // 这是本次修复的核心场景：sanitizeJson 修复换行 + 逆向搜索跳过假围栏
    const rawLlmOutput =
      '```json\n' +
      '{\n' +
      '  "decision": "SPAWN_SUB_AGENT",\n' +
      '  "rationale": "测试",\n' +
      '  "riskAssessment": {"level": "low", "notes": "ok"},\n' +
      '  "nextStep": {\n' +
      '    "task": "请撰写PRD：\\n\\n```\\n# 标题\\n## 章节\\n```\\n\\n保存文件",\n' +
      '    "tools": ["file_write"]\n' +
      '  }\n' +
      '}\n' +
      '```';

    const result = parseWithFallback<Record<string, unknown>>(rawLlmOutput);

    expect(result.success).toBe(true);
    expect(result.data?.decision).toBe('SPAWN_SUB_AGENT');
  });

  it('repairs an unterminated string value before the next property key', () => {
    const rawLlmOutput =
      '```json\n' +
      '{\n' +
      '  "decision": "SPAWN_SUB_AGENT",\n' +
      '  "rationale": "Need an image generation sub-agent.",\n' +
      '  "riskAssessment": { "level": "low", "notes": "No risk" },\n' +
      '  "nextStep": {\n' +
      '    "task": "Use the generate_image tool to create an image of a character standing\n' +
      'in a cozy kitchen, cooking a delicious-looking meal.\n' +
      '    "tools": ["generate_image"]\n' +
      '  }\n' +
      '}\n' +
      '```';

    const result = parseWithFallback<Record<string, unknown>>(rawLlmOutput);
    const nextStep = result.data?.nextStep as Record<string, unknown> | undefined;

    expect(result.success).toBe(true);
    expect(result.strategy).toBe('property-terminator-repair');
    expect(result.data?.decision).toBe('SPAWN_SUB_AGENT');
    expect(nextStep?.task).toContain('delicious-looking meal');
    expect(nextStep?.tools).toEqual(['generate_image']);
  });

  it('repairs a duplicated key-value prefix before the real value', () => {
    const rawLlmOutput =
      '```json\n' +
      '{\n' +
      '  "decision": "SPAWN_SUB_AGENT",\n' +
      '  "rationale": "rationale": "Need one generated image.",\n' +
      '  "riskAssessment": { "level": "low", "notes": "No risk" }\n' +
      '}\n' +
      '```';

    const result = parseWithFallback<Record<string, unknown>>(rawLlmOutput);

    expect(result.success).toBe(true);
    expect(result.strategy).toBe('common-structural-repair');
    expect(result.data?.rationale).toBe('Need one generated image.');
  });

  it('repairs nested quotes followed by prose commas inside string values', () => {
    const rawLlmOutput =
      '```json\n' +
      '{\n' +
      '  "decision": "RESPOND_TO_USER",\n' +
      '  "response": "Window title "GameViewer", interface shows "Remote UI", all checks passed."\n' +
      '}\n' +
      '```';

    const result = parseWithFallback<Record<string, unknown>>(rawLlmOutput);

    expect(result.success).toBe(true);
    expect(result.data?.response).toContain('"GameViewer", interface');
    expect(result.data?.response).toContain('"Remote UI", all checks');
  });

  it('repairs a widget chart whose string value ends with nested quotes', () => {
    const rawLlmOutput =
      '```widget-chart\n' +
      '{\n' +
      '  "title": "关键要点",\n' +
      '  "type": "info",\n' +
      '  "items": [\n' +
      '    {\n' +
      '      "label": "OpenAI 新图像模型（代号 "Spud"）",\n' +
      '      "icon": "Image",\n' +
      '      "description": "Arena 榜单出现代号 Masking Tape 等新模型；支持生成 YouTube 首页截图、收据等。"\n' +
      '    },\n' +
      '    {\n' +
      '      "label": "Nano Banana 2 vs GPT 图像模型",\n' +
      '      "icon": "ArrowLeftRight",\n' +
      '      "description": "GPT 模型在 "原始未编辑iPhone相机质量"任务中略胜一筹。"\n' +
      '    },\n' +
      '    {\n' +
      '      "label": "SeaDance 2.0 被超越",\n' +
      '      "icon": "Video",\n' +
      '      "description": "新视频模型 "Happy Horse" 登顶排行榜。"\n' +
      '    },\n' +
      '    {\n' +
      '      "label": "Milla Jovovich 开源AI记忆系统 "MemPlace"",\n' +
      '      "icon": "Brain",\n' +
      '      "description": "本地离线运行，兼容 Claude、ChatGPT、Cursor。"\n' +
      '    }\n' +
      '  ]\n' +
      '}\n' +
      '```';

    const result = parseWithFallback<Record<string, unknown>>(rawLlmOutput);
    const items = result.data?.items as Array<Record<string, unknown>> | undefined;

    expect(result.success).toBe(true);
    expect(result.strategy).toBe('sanitized');
    expect(items?.[0]?.label).toContain('"Spud"');
    expect(items?.[1]?.description).toContain('"原始未编辑iPhone相机质量"');
    expect(items?.[2]?.description).toContain('"Happy Horse"');
    expect(items?.[3]?.label).toContain('"MemPlace"');
  });

  it('removes orphan string members from objects without touching arrays', () => {
    const rawLlmOutput =
      '```json\n' +
      '{\n' +
      '  "metadata": {\n' +
      '    "status": "ready",\n' +
      '    "yes"\n' +
      '  },\n' +
      '  "tools": ["read", "file_write"]\n' +
      '}\n' +
      '```';

    const result = parseWithFallback<Record<string, unknown>>(rawLlmOutput);
    const metadata = result.data?.metadata as Record<string, unknown> | undefined;

    expect(result.success).toBe(true);
    expect(result.strategy).toBe('common-structural-repair');
    expect(metadata?.status).toBe('ready');
    expect(result.data?.tools).toEqual(['read', 'file_write']);
  });
});
