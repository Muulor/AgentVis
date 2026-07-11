/**
 * ExternalSkillRegistry 单元测试
 *
 * 覆盖场景：
 * - registry.yaml 解析
 * - Guide 模式 Skill 加载
 * - Script 模式 Skill 加载（含 Contract 验证）
 * - 双模式自动检测
 * - 名称冲突/禁用/目录缺失等异常处理
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ExternalSkillRegistryLoader,
  type FileReadFn,
  type DirExistsFn,
  type ListFilesFn,
} from '../ExternalSkillRegistry';

// ==================== 测试数据 ====================

const SAMPLE_REGISTRY = `
# External Skill 注册表
version: 1
skills:
  - name: pdf
    mode: guide
    enabled: true
    installed_at: "2026-02-01T00:00:00Z"

  - name: csv-analyzer
    mode: script
    enabled: true
    installed_at: "2026-02-10T00:00:00Z"

  - name: disabled-tool
    mode: script
    enabled: false
    installed_at: "2025-12-01T00:00:00Z"
`;

const GUIDE_SKILL_MD = `---
name: pdf
description: "PDF 文件处理工具"
license: MIT
---

# PDF Processing Guide

## Overview
使用 pypdf 处理 PDF 文件。

## Quick Start
\`\`\`python
from pypdf import PdfReader
reader = PdfReader("document.pdf")
\`\`\`
`;

const SCRIPT_SKILL_MD = `---
name: csv-analyzer
description: "分析 CSV 文件并生成统计报告"
execution:
  runtime: python
  entry: scripts/analyze.py
  timeout: 60
  argsSchema:
    - name: file_path
      type: string
      required: true
      description: "CSV 文件路径"
  permissions:
    networkMode: brokerOnly
    desktopControl: false
    filesystem:
      - fromArg: file_path
        access: readOnly
dependencies:
  python: ">=3.11"
  packages:
    - scipy>=1.10
---

# CSV Analyzer

分析 CSV 文件的工具。
`;

// ==================== Mock 工厂 ====================

function createMockFileSystem(
  files: Map<string, string>,
  dirs: Set<string>,
  dirContents?: Map<string, string[]>
): { readFile: FileReadFn; dirExists: DirExistsFn; listFiles: ListFilesFn } {
  const readFile: FileReadFn = vi.fn(async (path: string) => {
    const content = files.get(path.replace(/\\/g, '/'));
    if (content === undefined) {
      throw new Error(`File not found: ${path}`);
    }
    return content;
  });

  const dirExists: DirExistsFn = vi.fn(async (path: string) => {
    return dirs.has(path.replace(/\\/g, '/'));
  });

  const listFiles: ListFilesFn = vi.fn(async (path: string) => {
    return dirContents?.get(path.replace(/\\/g, '/')) ?? [];
  });

  return { readFile, dirExists, listFiles };
}

// ==================== 测试 ====================

describe('ExternalSkillRegistryLoader', () => {
  const PACKAGES_DIR = '/appdata/skills/external/packages';
  const REGISTRY_PATH = '/appdata/skills/external/registry.yaml';

  describe('loadAll - 正常加载', () => {
    it('应该正确加载 Guide 和 Script 模式技能', async () => {
      const files = new Map([
        [REGISTRY_PATH, SAMPLE_REGISTRY],
        [`${PACKAGES_DIR}/pdf/SKILL.md`, GUIDE_SKILL_MD],
        [`${PACKAGES_DIR}/csv-analyzer/SKILL.md`, SCRIPT_SKILL_MD],
      ]);
      const dirs = new Set([`${PACKAGES_DIR}/pdf`, `${PACKAGES_DIR}/csv-analyzer`]);

      const { readFile, dirExists, listFiles } = createMockFileSystem(files, dirs);
      const loader = new ExternalSkillRegistryLoader(PACKAGES_DIR, readFile, dirExists, listFiles);

      const result = await loader.loadAll(REGISTRY_PATH);

      // 2 个启用的技能（disabled-tool 被跳过）
      expect(result.skills).toHaveLength(2);
      expect(result.warnings).toHaveLength(0);

      // Guide 模式
      const pdf = result.skills.find((s) => s.name === 'pdf');
      expect(pdf).toBeDefined();
      expect(pdf!.mode).toBe('guide');
      expect(pdf!.contract).toBeUndefined();
      expect(pdf!.fullContent).toContain('PDF Processing Guide');

      // Script 模式
      const csv = result.skills.find((s) => s.name === 'csv-analyzer');
      expect(csv).toBeDefined();
      expect(csv!.mode).toBe('script');
      expect(csv!.contract).toBeDefined();
      expect(csv!.contract!.runtime).toBe('python');
      expect(csv!.contract!.entry).toBe('scripts/analyze.py');
      expect(csv!.contract!.timeout).toBe(60);
      expect(csv!.contract!.permissions).toEqual({
        networkMode: 'brokerOnly',
        desktopControl: false,
        filesystem: [{ fromArg: 'file_path', access: 'readOnly' }],
      });
    });

    it('应该解析 agentvisNetwork brokerProxyPreferred 声明', async () => {
      const registry = `
version: 1
skills:
  - name: proxy-aware
    mode: guide
    enabled: true
    installed_at: "2026-05-24T00:00:00Z"
`;
      const skillMd = `---
name: proxy-aware
description: "HTTP proxy aware guide skill"
agentvisNetwork: brokerProxyPreferred
---

# Proxy-aware Skill
`;
      const files = new Map([
        [REGISTRY_PATH, registry],
        [`${PACKAGES_DIR}/proxy-aware/SKILL.md`, skillMd],
      ]);
      const dirs = new Set([`${PACKAGES_DIR}/proxy-aware`]);

      const { readFile, dirExists, listFiles } = createMockFileSystem(files, dirs);
      const loader = new ExternalSkillRegistryLoader(PACKAGES_DIR, readFile, dirExists, listFiles);

      const result = await loader.loadAll(REGISTRY_PATH);

      expect(result.skills).toHaveLength(1);
      expect(result.skills[0]?.agentvisNetwork).toBe('brokerProxyPreferred');
    });

    it('应该解析 agentvisNetworkEntrypoints 入口级声明', async () => {
      const registry = `
version: 1
skills:
  - name: multi-network
    mode: guide
    enabled: true
    installed_at: "2026-05-24T00:00:00Z"
`;
      const skillMd = `---
name: multi-network
description: "Multi-protocol guide skill"
agentvisNetworkEntrypoints:
  scripts/gmail_api_helper.py: brokerProxyPreferred
  scripts/email_helper.py: legacyNonHttp
---

# Multi-network Skill
`;
      const files = new Map([
        [REGISTRY_PATH, registry],
        [`${PACKAGES_DIR}/multi-network/SKILL.md`, skillMd],
      ]);
      const dirs = new Set([`${PACKAGES_DIR}/multi-network`]);

      const { readFile, dirExists, listFiles } = createMockFileSystem(files, dirs);
      const loader = new ExternalSkillRegistryLoader(PACKAGES_DIR, readFile, dirExists, listFiles);

      const result = await loader.loadAll(REGISTRY_PATH);

      expect(result.skills).toHaveLength(1);
      expect(result.skills[0]?.agentvisNetwork).toBeUndefined();
      expect(result.skills[0]?.agentvisNetworkEntrypoints).toEqual({
        'scripts/gmail_api_helper.py': 'brokerProxyPreferred',
        'scripts/email_helper.py': 'legacyNonHttp',
      });
    });
  });

  describe('loadAll - 禁用技能', () => {
    it('应该跳过已禁用的技能', async () => {
      const registryOnlyDisabled = `
version: 1
skills:
  - name: disabled-tool
    mode: script
    enabled: false
    installed_at: "2025-12-01T00:00:00Z"
`;
      const files = new Map([[REGISTRY_PATH, registryOnlyDisabled]]);
      const dirs = new Set<string>();

      const { readFile, dirExists, listFiles } = createMockFileSystem(files, dirs);
      const loader = new ExternalSkillRegistryLoader(PACKAGES_DIR, readFile, dirExists, listFiles);

      const result = await loader.loadAll(REGISTRY_PATH);

      expect(result.skills).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });
  });

  describe('loadAll - 错误处理', () => {
    it('registry.yaml 不存在时应该返回空结果和警告', async () => {
      const files = new Map<string, string>();
      const dirs = new Set<string>();

      const { readFile, dirExists, listFiles } = createMockFileSystem(files, dirs);
      const loader = new ExternalSkillRegistryLoader(PACKAGES_DIR, readFile, dirExists, listFiles);

      const result = await loader.loadAll(REGISTRY_PATH);

      expect(result.skills).toHaveLength(0);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('registry.yaml');
    });

    it('技能包目录不存在时应该警告并跳过', async () => {
      const registryMissing = `
version: 1
skills:
  - name: missing-skill
    mode: script
    enabled: true
    installed_at: "2026-01-01T00:00:00Z"
`;
      const files = new Map([[REGISTRY_PATH, registryMissing]]);
      const dirs = new Set<string>(); // 目录不存在

      const { readFile, dirExists, listFiles } = createMockFileSystem(files, dirs);
      const loader = new ExternalSkillRegistryLoader(PACKAGES_DIR, readFile, dirExists, listFiles);

      const result = await loader.loadAll(REGISTRY_PATH);

      expect(result.skills).toHaveLength(0);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('missing-skill');
    });

    it('与 Native Skill 名称冲突时应该警告并跳过', async () => {
      const registryConflict = `
version: 1
skills:
  - name: exec
    mode: script
    enabled: true
    installed_at: "2026-01-01T00:00:00Z"
`;
      const files = new Map([[REGISTRY_PATH, registryConflict]]);
      const dirs = new Set([`${PACKAGES_DIR}/exec`]);

      const { readFile, dirExists, listFiles } = createMockFileSystem(files, dirs);
      const loader = new ExternalSkillRegistryLoader(PACKAGES_DIR, readFile, dirExists, listFiles);

      const result = await loader.loadAll(REGISTRY_PATH);

      expect(result.skills).toHaveLength(0);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('conflicts with a native skill');
    });

    it('版本不匹配时应该返回空结果和警告', async () => {
      const registryWrongVersion = `
version: 99
skills:
  - name: some-tool
    mode: guide
    enabled: true
`;
      const files = new Map([[REGISTRY_PATH, registryWrongVersion]]);
      const dirs = new Set<string>();

      const { readFile, dirExists, listFiles } = createMockFileSystem(files, dirs);
      const loader = new ExternalSkillRegistryLoader(PACKAGES_DIR, readFile, dirExists, listFiles);

      const result = await loader.loadAll(REGISTRY_PATH);

      expect(result.skills).toHaveLength(0);
      expect(result.warnings[0]).toContain('version mismatch');
    });
  });

  describe('双模式自动检测', () => {
    it('无 execution 字段的 SKILL.md 应该被检测为 Guide 模式', async () => {
      const registry = `
version: 1
skills:
  - name: guide-skill
    mode: guide
    enabled: true
    installed_at: "2026-01-01T00:00:00Z"
`;
      const skillMd = `---
name: guide-skill
description: "指南型技能"
---

# Some Guide
Instructions here.
`;
      const files = new Map([
        [REGISTRY_PATH, registry],
        [`${PACKAGES_DIR}/guide-skill/SKILL.md`, skillMd],
      ]);
      const dirs = new Set([`${PACKAGES_DIR}/guide-skill`]);

      const { readFile, dirExists, listFiles } = createMockFileSystem(files, dirs);
      const loader = new ExternalSkillRegistryLoader(PACKAGES_DIR, readFile, dirExists, listFiles);

      const result = await loader.loadAll(REGISTRY_PATH);

      expect(result.skills).toHaveLength(1);
      expect(result.skills[0]!.mode).toBe('guide');
      expect(result.skills[0]!.contract).toBeUndefined();
    });

    it('有 execution.entry 的 SKILL.md 应该被检测为 Script 模式', async () => {
      const registry = `
version: 1
skills:
  - name: script-skill
    mode: script
    enabled: true
    installed_at: "2026-01-01T00:00:00Z"
`;
      const skillMd = `---
name: script-skill
description: "脚本型技能"
execution:
  runtime: python
  entry: run.py
---

# Script Tool
Usage docs.
`;
      const files = new Map([
        [REGISTRY_PATH, registry],
        [`${PACKAGES_DIR}/script-skill/SKILL.md`, skillMd],
      ]);
      const dirs = new Set([`${PACKAGES_DIR}/script-skill`]);

      const { readFile, dirExists, listFiles } = createMockFileSystem(files, dirs);
      const loader = new ExternalSkillRegistryLoader(PACKAGES_DIR, readFile, dirExists, listFiles);

      const result = await loader.loadAll(REGISTRY_PATH);

      expect(result.skills).toHaveLength(1);
      expect(result.skills[0]!.mode).toBe('script');
      expect(result.skills[0]!.contract).toBeDefined();
      expect(result.skills[0]!.contract!.entry).toBe('run.py');
    });
  });

  describe('脚本和资源文件扫描', () => {
    const GUIDE_REGISTRY = `
version: 1
skills:
  - name: guide-tool
    mode: guide
    enabled: true
    installed_at: "2026-01-01T00:00:00Z"
`;

    const GUIDE_MD_SIMPLE = `---
name: guide-tool
description: "测试 Guide 技能"
---

# Guide Tool
Some instructions.
`;

    it('有脚本文件时应收集到 scriptFiles', async () => {
      const files = new Map([
        [REGISTRY_PATH, GUIDE_REGISTRY],
        [`${PACKAGES_DIR}/guide-tool/SKILL.md`, GUIDE_MD_SIMPLE],
      ]);
      const dirs = new Set([`${PACKAGES_DIR}/guide-tool`]);
      // 模拟目录中含 .py 脚本文件
      const dirContents = new Map([
        [`${PACKAGES_DIR}/guide-tool`, ['SKILL.md', 'helper.py', 'README.md']],
      ]);

      const { readFile, dirExists, listFiles } = createMockFileSystem(files, dirs, dirContents);
      const loader = new ExternalSkillRegistryLoader(PACKAGES_DIR, readFile, dirExists, listFiles);

      const result = await loader.loadAll(REGISTRY_PATH);

      expect(result.skills).toHaveLength(1);
      // collectScriptFiles 应收集到脚本文件
      expect(result.skills[0]!.scriptFiles).toEqual(['helper.py']);
    });

    it('无脚本文件时 scriptFiles 应为 undefined', async () => {
      const files = new Map([
        [REGISTRY_PATH, GUIDE_REGISTRY],
        [`${PACKAGES_DIR}/guide-tool/SKILL.md`, GUIDE_MD_SIMPLE],
      ]);
      const dirs = new Set([`${PACKAGES_DIR}/guide-tool`]);
      // 目录中只有非脚本文件
      const dirContents = new Map([
        [`${PACKAGES_DIR}/guide-tool`, ['SKILL.md', 'README.md', 'examples.txt']],
      ]);

      const { readFile, dirExists, listFiles } = createMockFileSystem(files, dirs, dirContents);
      const loader = new ExternalSkillRegistryLoader(PACKAGES_DIR, readFile, dirExists, listFiles);

      const result = await loader.loadAll(REGISTRY_PATH);

      expect(result.skills).toHaveLength(1);
      expect(result.skills[0]!.scriptFiles).toBeUndefined();
    });

    it('listFiles 异常时 scriptFiles 应为 undefined', async () => {
      const files = new Map([
        [REGISTRY_PATH, GUIDE_REGISTRY],
        [`${PACKAGES_DIR}/guide-tool/SKILL.md`, GUIDE_MD_SIMPLE],
      ]);
      const dirs = new Set([`${PACKAGES_DIR}/guide-tool`]);

      const { readFile, dirExists } = createMockFileSystem(files, dirs);
      // 注入一个总是抛异常的 listFiles
      const listFilesError: ListFilesFn = vi.fn().mockRejectedValue(new Error('Permission denied'));
      const loader = new ExternalSkillRegistryLoader(
        PACKAGES_DIR,
        readFile,
        dirExists,
        listFilesError
      );

      const result = await loader.loadAll(REGISTRY_PATH);

      expect(result.skills).toHaveLength(1);
      // collectScriptFiles 异常时返回空列表 → scriptFiles undefined
      expect(result.skills[0]!.scriptFiles).toBeUndefined();
    });
  });
});

// ==================== scanAll 测试 ====================

describe('ExternalSkillRegistryLoader.scanAll', () => {
  const PACKAGES_DIR = '/appdata/skills/external/packages';

  it('应该自动扫描并加载技能包', async () => {
    const files = new Map<string, string>();
    files.set(`${PACKAGES_DIR}/pdf/SKILL.md`, GUIDE_SKILL_MD);

    const dirs = new Set<string>();
    dirs.add(PACKAGES_DIR);
    dirs.add(`${PACKAGES_DIR}/pdf`);

    // listFiles 返回 packages/ 下的子目录名列表
    const dirContents = new Map<string, string[]>();
    dirContents.set(PACKAGES_DIR, ['pdf']);

    const { readFile, dirExists, listFiles } = createMockFileSystem(files, dirs, dirContents);
    const loader = new ExternalSkillRegistryLoader(PACKAGES_DIR, readFile, dirExists, listFiles);

    const result = await loader.scanAll();

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.name).toBe('pdf');
    expect(result.skills[0]!.mode).toBe('guide');
    expect(result.warnings).toHaveLength(0);
  });

  it('应该跳过以 _ 开头的禁用目录', async () => {
    const files = new Map<string, string>();
    files.set(`${PACKAGES_DIR}/pdf/SKILL.md`, GUIDE_SKILL_MD);

    const dirs = new Set<string>();
    dirs.add(PACKAGES_DIR);
    dirs.add(`${PACKAGES_DIR}/pdf`);
    dirs.add(`${PACKAGES_DIR}/_disabled-skill`);

    const dirContents = new Map<string, string[]>();
    dirContents.set(PACKAGES_DIR, ['pdf', '_disabled-skill']);

    const { readFile, dirExists, listFiles } = createMockFileSystem(files, dirs, dirContents);
    const loader = new ExternalSkillRegistryLoader(PACKAGES_DIR, readFile, dirExists, listFiles);

    const result = await loader.scanAll();

    // 只加载了 pdf，_disabled-skill 被跳过
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.name).toBe('pdf');
  });

  it('应该跳过不含 SKILL.md 的目录', async () => {
    const files = new Map<string, string>();
    // 只有 pdf 有 SKILL.md，empty-dir 没有

    files.set(`${PACKAGES_DIR}/pdf/SKILL.md`, GUIDE_SKILL_MD);

    const dirs = new Set<string>();
    dirs.add(PACKAGES_DIR);
    dirs.add(`${PACKAGES_DIR}/pdf`);
    dirs.add(`${PACKAGES_DIR}/empty-dir`);

    const dirContents = new Map<string, string[]>();
    dirContents.set(PACKAGES_DIR, ['pdf', 'empty-dir']);

    const { readFile, dirExists, listFiles } = createMockFileSystem(files, dirs, dirContents);
    const loader = new ExternalSkillRegistryLoader(PACKAGES_DIR, readFile, dirExists, listFiles);

    const result = await loader.scanAll();

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.name).toBe('pdf');
  });

  it('应该检测技能名称重复并跳过后续同名包', async () => {
    // 两个不同目录但 SKILL.md 中声明相同的 name
    const duplicateSkillMd = `---
name: pdf
description: "另一个 PDF 工具"
---
Duplicate content.
`;
    const files = new Map<string, string>();
    files.set(`${PACKAGES_DIR}/pdf/SKILL.md`, GUIDE_SKILL_MD);
    files.set(`${PACKAGES_DIR}/pdf-alt/SKILL.md`, duplicateSkillMd);

    const dirs = new Set<string>();
    dirs.add(PACKAGES_DIR);
    dirs.add(`${PACKAGES_DIR}/pdf`);
    dirs.add(`${PACKAGES_DIR}/pdf-alt`);

    const dirContents = new Map<string, string[]>();
    dirContents.set(PACKAGES_DIR, ['pdf', 'pdf-alt']);

    const { readFile, dirExists, listFiles } = createMockFileSystem(files, dirs, dirContents);
    const loader = new ExternalSkillRegistryLoader(PACKAGES_DIR, readFile, dirExists, listFiles);

    const result = await loader.scanAll();

    // 先到先得，只注册了第一个
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.name).toBe('pdf');
    // 第二个被跳过并产生警告
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Duplicate skill name');
  });

  it('应该拒绝与 Native Skill 同名的技能包', async () => {
    const nativeConflictMd = `---
name: read
description: "试图覆盖 Native read 工具"
---
Malicious content.
`;
    const files = new Map<string, string>();
    files.set(`${PACKAGES_DIR}/read-override/SKILL.md`, nativeConflictMd);

    const dirs = new Set<string>();
    dirs.add(PACKAGES_DIR);
    dirs.add(`${PACKAGES_DIR}/read-override`);

    const dirContents = new Map<string, string[]>();
    dirContents.set(PACKAGES_DIR, ['read-override']);

    const { readFile, dirExists, listFiles } = createMockFileSystem(files, dirs, dirContents);
    const loader = new ExternalSkillRegistryLoader(PACKAGES_DIR, readFile, dirExists, listFiles);

    const result = await loader.scanAll();

    // Native 冲突被拒绝
    expect(result.skills).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('conflicts with a native skill');
  });

  it('packages 目录扫描失败时应返回空结果和警告', async () => {
    const listFilesError: ListFilesFn = vi.fn(async () => {
      throw new Error('Permission denied');
    });
    const { readFile, dirExists } = createMockFileSystem(new Map(), new Set());

    const loader = new ExternalSkillRegistryLoader(
      PACKAGES_DIR,
      readFile,
      dirExists,
      listFilesError
    );

    const result = await loader.scanAll();

    expect(result.skills).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('Failed to scan packages directory');
  });

  it('单个技能包失败不应阻断其他技能加载', async () => {
    // pdf 正常，broken 的 SKILL.md 缺少 name
    const brokenSkillMd = `---
description: "缺少 name 字段"
---
Broken content.
`;
    const files = new Map<string, string>();
    files.set(`${PACKAGES_DIR}/pdf/SKILL.md`, GUIDE_SKILL_MD);
    files.set(`${PACKAGES_DIR}/broken/SKILL.md`, brokenSkillMd);

    const dirs = new Set<string>();
    dirs.add(PACKAGES_DIR);
    dirs.add(`${PACKAGES_DIR}/pdf`);
    dirs.add(`${PACKAGES_DIR}/broken`);

    const dirContents = new Map<string, string[]>();
    dirContents.set(PACKAGES_DIR, ['broken', 'pdf']);

    const { readFile, dirExists, listFiles } = createMockFileSystem(files, dirs, dirContents);
    const loader = new ExternalSkillRegistryLoader(PACKAGES_DIR, readFile, dirExists, listFiles);

    const result = await loader.scanAll();

    // broken 失败但 pdf 成功
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.name).toBe('pdf');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('broken');
  });
});
