/**
 * PostWriteValidator 单元测试 v2.4
 *
 * 使用 callCount + mockImplementation 为每个 test 精确控制 invoke 返回序列。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@services/logger', () => ({
  getLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { invoke } from '@tauri-apps/api/core';
import { validateSyntax } from '../PostWriteValidator';

const mockInvoke = vi.mocked(invoke);

function shellOk(stdout = '', stderr = '') {
  return { exitCode: 0, stdout, stderr };
}
function shellFail(stdout = '', stderr = '') {
  return { exitCode: 1, stdout, stderr };
}

function normalizeTestPath(path: string): string {
  return path.replace(/\\/g, '/');
}

function getInvokeArgs(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
}

function getInvokeStringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function cargoMessage(filePath: string, line: number, column: number, message: string): string {
  return JSON.stringify({
    reason: 'compiler-message',
    message: {
      level: 'error',
      message,
      spans: [
        {
          file_name: filePath,
          line_start: line,
          column_start: column,
          is_primary: true,
        },
      ],
    },
  });
}

function pyrightOutput(
  diagnostics: Array<{
    file: string;
    line: number;
    column: number;
    message: string;
    severity?: string;
  }>
): string {
  return JSON.stringify({
    generalDiagnostics: diagnostics.map((diagnostic) => ({
      file: diagnostic.file,
      severity: diagnostic.severity ?? 'error',
      message: diagnostic.message,
      range: {
        start: {
          line: diagnostic.line - 1,
          character: diagnostic.column - 1,
        },
      },
    })),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ══════════════════════════════════════════════════════════
// tsc 项目模式
// ══════════════════════════════════════════════════════════
describe('tsc - 项目模式', () => {
  it('找到 tsconfig.json，只过滤当前文件错误', async () => {
    let callCount = 0;
    mockInvoke.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return '{}'; // file_read_content(tsconfig)
      return shellFail(
        [
          'src/engine/AudioEngine.ts(45,7): error TS2339: Property x not exist.',
          'src/mixer/Mixer.ts(12,3): error TS2345: Wrong type.',
        ].join('\n'),
        ''
      );
    });

    const result = await validateSyntax('C:\\proj\\src\\engine\\AudioEngine.ts', {});

    expect(result.tool).toBe('tsc');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.line).toBe(45);
  });

  it('同名文件不同目录，仅匹配目标文件', async () => {
    // audio/Track.ts 和 components/Track.ts 的后 2 段不同
    let callCount = 0;
    mockInvoke.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return '{}';
      return shellFail(
        [
          'src/components/Track.ts(5,1): error TS2345: components error.',
          'src/audio/Track.ts(10,2): error TS2339: audio error.',
        ].join('\n'),
        ''
      );
    });

    const result = await validateSyntax('C:\\proj\\src\\audio\\Track.ts', {});

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.line).toBe(10);
    expect(result.errors[0]!.message).toContain('audio error');
  });

  it('解析 Windows 绝对路径形式的 tsc 错误', async () => {
    let callCount = 0;
    mockInvoke.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return '{}'; // file_read_content(tsconfig)
      if (callCount <= 3) throw new Error('not found'); // local tsc candidates
      return shellFail(
        'C:\\proj\\src\\foo.ts(8,4): error TS2322: Type string is not assignable to type number.',
        ''
      );
    });

    const result = await validateSyntax('C:\\proj\\src\\foo.ts', {});

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.filePath).toBe('C:\\proj\\src\\foo.ts');
    expect(result.errors[0]!.line).toBe(8);
    expect(result.errors[0]!.column).toBe(4);
  });

  it('当前文件无直接错误时保留项目级相关诊断', async () => {
    let callCount = 0;
    mockInvoke.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return '{}'; // file_read_content(tsconfig)
      return shellFail(
        [
          'src/consumer.ts(12,8): error TS2305: Module "./types" has no exported member "WidgetConfig".',
          'src/components/App.tsx(22,14): error TS2322: Type string is not assignable to type number.',
        ].join('\n'),
        ''
      );
    });

    const result = await validateSyntax('C:\\proj\\src\\types.ts', {});

    expect(result.errors).toHaveLength(0);
    expect(result.relatedErrors).toHaveLength(2);
    expect(result.projectErrorCount).toBe(2);
    expect(result.relatedErrors?.[0]?.filePath).toBe('src/consumer.ts');
  });

  it('错误数超 5 条时只返回前 5 条', async () => {
    let callCount = 0;
    mockInvoke.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return '{}';
      const manyErrors = Array.from(
        { length: 10 },
        (_, i) => `src/foo.ts(${i + 1},1): error TS${2000 + i}: err${i}.`
      ).join('\n');
      return shellFail(manyErrors, '');
    });

    const result = await validateSyntax('C:\\proj\\src\\foo.ts', {});

    expect(result.errors.length).toBe(5);
  });

  it('未找到 tsconfig（C:\\tmp 只有 2 层），降级为单文件模式', async () => {
    // C:\tmp\foo.ts 的目录链：C:\tmp → C:（2 层）
    // 所以 file_read_content 会被调用 2 次，全部 throw
    // 第 3 次调用是单文件 tsc，返回成功
    let callCount = 0;
    mockInvoke.mockImplementation(async () => {
      callCount++;
      if (callCount <= 1) throw new Error('not found');
      return shellFail("foo.ts(3,1): error TS1005: ';' expected.", '');
    });

    const result = await validateSyntax('C:\\tmp\\foo.ts', {});

    expect(result.tool).toBe('tsc');
    expect(result.errors[0]!.line).toBe(3);
  });

  it('tsc throw 后降级括号配对', async () => {
    // invoke 调用顺序（从实现中推导）：
    // callCount=1: file_read_content(tsconfig.json) → 返回 '{}'（tsconfig 找到）
    // callCount=2: file_read_content(node_modules/.bin/tsc.cmd) → throw（找不到）
    // callCount=3: file_read_content(node_modules/.bin/tsc) → throw（找不到）
    //   → findLocalTscBinary 返回 undefined，使用 npx tsc
    // callCount=4: shell_execute(npx tsc --incremental) → throw（模拟超时）
    // callCount=5: file_read_content（括号配对降级）→ 返回代码内容
    let callCount = 0;
    mockInvoke.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return '{}'; // tsconfig
      if (callCount === 2) throw new Error('not found'); // tsc.cmd 不存在
      if (callCount === 3) throw new Error('not found'); // tsc 不存在
      if (callCount === 4) throw new Error('timeout'); // npx tsc 超时
      return 'const x = { a: 1 };'; // file_read_content（括号配对）
    });

    const result = await validateSyntax('C:\\proj\\ok.ts', {});

    expect(result.tool).toBe('bracket_fallback');
    expect(result.errors).toHaveLength(0);
  });

  it('无错误时返回空 errors', async () => {
    let callCount = 0;
    mockInvoke.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return '{}';
      return shellOk();
    });

    const result = await validateSyntax('C:\\proj\\ok.ts', {});

    expect(result.errors).toHaveLength(0);
  });

  it('.tsx 路由到 tsc', async () => {
    let callCount = 0;
    mockInvoke.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return '{}';
      return shellOk();
    });

    const result = await validateSyntax('C:\\proj\\App.tsx', {});

    expect(result.tool).toBe('tsc');
  });
});

// ══════════════════════════════════════════════════════════
// Python
// ══════════════════════════════════════════════════════════
describe('Python (.py)', () => {
  it('解析 File "...", line N 格式', async () => {
    const stderr = '  File "/project/script.py", line 10\n    x = 1 +\nSyntaxError: invalid syntax';
    mockInvoke.mockResolvedValue(shellFail('', stderr));

    const result = await validateSyntax('/project/script.py', {});

    expect(result.tool).toBe('py_compile');
    expect(result.errors[0]!.line).toBe(10);
    expect(result.errors[0]!.message).toContain('SyntaxError');
  });

  it('无错误时 errors 为空', async () => {
    mockInvoke.mockResolvedValue(shellOk());

    const result = await validateSyntax('/project/ok.py', {});

    expect(result.tool).toBe('py_compile');
    expect(result.errors).toHaveLength(0);
  });

  it('py_compile 当前文件有语法错误时不继续运行项目检查', async () => {
    const shellCommands: string[] = [];
    mockInvoke.mockImplementation(async (command, args) => {
      const invokeArgs = getInvokeArgs(args);
      if (command === 'file_read_content') throw new Error('should not search project config');
      shellCommands.push(getInvokeStringArg(invokeArgs, 'command'));
      return shellFail(
        '',
        '  File "/project/script.py", line 8\n    return x +\nSyntaxError: invalid syntax'
      );
    });

    const result = await validateSyntax('/project/script.py', {});

    expect(result.tool).toBe('py_compile');
    expect(result.errors).toHaveLength(1);
    expect(shellCommands).toHaveLength(1);
  });

  it('有 Pyright 配置和本地 pyright 时解析 current/related 诊断', async () => {
    mockInvoke.mockImplementation(async (command, args) => {
      const invokeArgs = getInvokeArgs(args);
      if (command === 'file_read_content') {
        const filePath = normalizeTestPath(getInvokeStringArg(invokeArgs, 'filePath'));
        if (filePath.endsWith('/project/pyrightconfig.json')) return '{}';
        if (filePath.endsWith('/project/node_modules/.bin/pyright.cmd')) return '@echo off';
        throw new Error('not found');
      }

      const shellCommand = getInvokeStringArg(invokeArgs, 'command');
      if (shellCommand.includes('py_compile')) return shellOk();
      expect(shellCommand).toContain('pyright.cmd');
      expect(shellCommand).toContain('--outputjson');
      return shellFail(
        pyrightOutput([
          { file: '/project/src/app.py', line: 4, column: 7, message: 'Type mismatch' },
          { file: '/project/src/consumer.py', line: 12, column: 3, message: 'Unknown import' },
          {
            file: '/project/src/warn.py',
            line: 1,
            column: 1,
            message: 'Warning only',
            severity: 'warning',
          },
        ]),
        ''
      );
    });

    const result = await validateSyntax('/project/src/app.py', {});

    expect(result.tool).toBe('pyright');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toContain('Type mismatch');
    expect(result.relatedErrors).toHaveLength(1);
    expect(result.relatedErrors?.[0]?.filePath).toContain('consumer.py');
    expect(result.projectErrorCount).toBe(2);
  });

  it('有 Mypy 配置时解析 current/related 诊断', async () => {
    mockInvoke.mockImplementation(async (command, args) => {
      const invokeArgs = getInvokeArgs(args);
      if (command === 'file_read_content') {
        const filePath = normalizeTestPath(getInvokeStringArg(invokeArgs, 'filePath'));
        if (filePath.endsWith('/project/mypy.ini')) return '[mypy]';
        throw new Error('not found');
      }

      const shellCommand = getInvokeStringArg(invokeArgs, 'command');
      if (shellCommand.includes('py_compile')) return shellOk();
      expect(shellCommand).toContain('-m mypy');
      return shellFail(
        [
          'src/app.py:6:9: error: Incompatible return value type',
          'src/consumer.py:3: error: Module has no attribute',
        ].join('\n'),
        ''
      );
    });

    const result = await validateSyntax('/project/src/app.py', {});

    expect(result.tool).toBe('mypy');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.column).toBe(9);
    expect(result.relatedErrors).toHaveLength(1);
    expect(result.projectErrorCount).toBe(2);
  });

  it('项目级 Python 工具失败时返回已通过的 py_compile 结果', async () => {
    mockInvoke.mockImplementation(async (command, args) => {
      const invokeArgs = getInvokeArgs(args);
      if (command === 'file_read_content') {
        const filePath = normalizeTestPath(getInvokeStringArg(invokeArgs, 'filePath'));
        if (filePath.endsWith('/project/pyrightconfig.json')) return '{}';
        if (filePath.endsWith('/project/node_modules/.bin/pyright.cmd')) return '@echo off';
        throw new Error('not found');
      }

      const shellCommand = getInvokeStringArg(invokeArgs, 'command');
      if (shellCommand.includes('py_compile')) return shellOk();
      throw new Error('pyright unavailable');
    });

    const result = await validateSyntax('/project/src/app.py', {});

    expect(result.tool).toBe('py_compile');
    expect(result.errors).toHaveLength(0);
  });

  it('超时 throw 后降级括号配对', async () => {
    let callCount = 0;
    mockInvoke.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('timeout');
      return 'def foo():\n    return {"key": "val"}\n';
    });

    const result = await validateSyntax('/project/ok.py', {});

    expect(result.tool).toBe('bracket_fallback');
    expect(result.errors).toHaveLength(0);
  });

  it('Windows 路径（C:\\...）中的盘符冒号不被误识别', async () => {
    const stderr = 'C:\\Users\\Admin\\script.py:5: SyntaxError: bad syntax';
    mockInvoke.mockResolvedValue(shellFail('', stderr));

    const result = await validateSyntax('C:\\Users\\Admin\\script.py', {});

    expect(result.tool).toBe('py_compile');
    for (const e of result.errors) {
      expect(e.line).toBeGreaterThan(0);
    }
  });
});

// ══════════════════════════════════════════════════════════
// JavaScript
// ══════════════════════════════════════════════════════════
describe('JavaScript (.js / .mjs)', () => {
  it('有本地 ESLint 时优先运行 eslint --quiet --format json', async () => {
    mockInvoke.mockImplementation(async (command, args) => {
      const invokeArgs = getInvokeArgs(args);
      if (command === 'file_read_content') {
        const filePath = normalizeTestPath(getInvokeStringArg(invokeArgs, 'filePath'));
        if (filePath.endsWith('/project/.eslintrc.cjs')) return 'module.exports = {}';
        if (filePath.endsWith('/project/node_modules/.bin/eslint.cmd')) return '@echo off';
        throw new Error('not found');
      }

      const shellCommand = getInvokeStringArg(invokeArgs, 'command');
      expect(shellCommand).toContain('eslint.cmd');
      expect(shellCommand).toContain('--quiet --format json');
      return shellFail(
        JSON.stringify([
          {
            filePath: '/project/src/bad.js',
            messages: [
              {
                severity: 1,
                line: 1,
                column: 1,
                ruleId: 'no-console',
                message: 'Unexpected console statement.',
              },
              {
                severity: 2,
                line: 5,
                column: 3,
                ruleId: 'no-undef',
                message: "'x' is not defined.",
              },
            ],
          },
        ]),
        ''
      );
    });

    const result = await validateSyntax('/project/src/bad.js', {});

    expect(result.tool).toBe('eslint');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.message).toContain("no-undef: 'x' is not defined.");
  });

  it('解析 node --check 错误（path:line 格式）', async () => {
    mockInvoke.mockImplementation(async (command, args) => {
      const invokeArgs = getInvokeArgs(args);
      if (command === 'file_read_content') throw new Error('not found');
      expect(getInvokeStringArg(invokeArgs, 'command')).toContain('node --check');
      return shellFail('', '/project/bad.js:5\nSyntaxError: Unexpected token }');
    });

    const result = await validateSyntax('/project/bad.js', {});

    expect(result.tool).toBe('node_check');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.line).toBe(5);
  });

  it('无语法错误时 errors 为空', async () => {
    mockInvoke.mockImplementation(async (command, args) => {
      const invokeArgs = getInvokeArgs(args);
      if (command === 'file_read_content') throw new Error('not found');
      expect(getInvokeStringArg(invokeArgs, 'command')).toContain('node --check');
      return shellOk();
    });

    const result = await validateSyntax('/project/ok.js', {});

    expect(result.tool).toBe('node_check');
    expect(result.errors).toHaveLength(0);
  });

  it('.mjs 路由到 node_check', async () => {
    mockInvoke.mockImplementation(async (command, args) => {
      const invokeArgs = getInvokeArgs(args);
      if (command === 'file_read_content') throw new Error('not found');
      expect(getInvokeStringArg(invokeArgs, 'command')).toContain('node --check');
      return shellOk();
    });

    const result = await validateSyntax('/project/module.mjs', {});

    expect(result.tool).toBe('node_check');
  });

  it('throw 后降级括号配对', async () => {
    mockInvoke.mockImplementation(async (command, args) => {
      const invokeArgs = getInvokeArgs(args);
      if (command === 'file_read_content') {
        const filePath = normalizeTestPath(getInvokeStringArg(invokeArgs, 'filePath'));
        if (filePath.endsWith('/project/ok.js')) return 'const x = [1, 2];';
        throw new Error('not found');
      }
      throw new Error('timeout');
    });

    const result = await validateSyntax('/project/ok.js', {});

    expect(result.tool).toBe('bracket_fallback');
    expect(result.errors).toHaveLength(0);
  });

  it('.jsx 无 ESLint 时不运行 node --check，直接括号兜底', async () => {
    const shellCalls: string[] = [];
    mockInvoke.mockImplementation(async (command, args) => {
      const invokeArgs = getInvokeArgs(args);
      if (command === 'file_read_content') {
        const filePath = normalizeTestPath(getInvokeStringArg(invokeArgs, 'filePath'));
        if (filePath.endsWith('/project/src/App.jsx'))
          return 'export function App() { return <div />; }';
        throw new Error('not found');
      }
      shellCalls.push(getInvokeStringArg(invokeArgs, 'command'));
      return shellOk();
    });

    const result = await validateSyntax('/project/src/App.jsx', {});

    expect(result.tool).toBe('bracket_fallback');
    expect(shellCalls).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════
// JSON
// ══════════════════════════════════════════════════════════
describe('JSON (.json)', () => {
  it('解析 json.tool 错误含行列号', async () => {
    const stderr = "Expecting ',' delimiter: line 5 column 3 (char 42)";
    mockInvoke.mockResolvedValue(shellFail('', stderr));

    const result = await validateSyntax('/project/config.json', {});

    expect(result.tool).toBe('json_tool');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.line).toBe(5);
    expect(result.errors[0]!.column).toBe(3);
  });

  it('命令中不含 --no-ensure-ascii（Python 3.8 兼容）', async () => {
    mockInvoke.mockResolvedValue(shellOk());

    await validateSyntax('/project/ok.json', {});

    const params = mockInvoke.mock.calls[0]?.[1] as { command?: string } | undefined;
    expect(params?.command).not.toContain('--no-ensure-ascii');
  });

  it('throw 时降级为 JSON.parse，无效 JSON 报错', async () => {
    let callCount = 0;
    mockInvoke.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('python not found');
      return '{ "key": invalid }';
    });

    const result = await validateSyntax('/project/bad.json', {});

    expect(result.tool).toBe('json_tool');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.line).toBe(0);
  });

  it('throw 时降级为 JSON.parse，合法 JSON 无错误', async () => {
    let callCount = 0;
    mockInvoke.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('python not found');
      return '{"key": "value"}';
    });

    const result = await validateSyntax('/project/ok.json', {});

    expect(result.tool).toBe('json_tool');
    expect(result.errors).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════
// YAML / TOML
// ══════════════════════════════════════════════════════════
describe('YAML (.yaml / .yml)', () => {
  it('合法 YAML 返回空 errors', async () => {
    mockInvoke.mockResolvedValue('name: demo\nitems:\n  - one\n');

    const result = await validateSyntax('/project/config.yaml', {});

    expect(result.tool).toBe('yaml_parse');
    expect(result.checked).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('YAML 语法错误返回行列号', async () => {
    mockInvoke.mockResolvedValue('name: demo\nitems:\n  - one\n  bad: : value\n');

    const result = await validateSyntax('/project/config.yaml', {});

    expect(result.tool).toBe('yaml_parse');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.line).toBeGreaterThan(0);
    expect(result.errors[0]!.column).toBeGreaterThan(0);
  });

  it('多文档 YAML 使用 loadAll，不误报', async () => {
    mockInvoke.mockResolvedValue('---\na: 1\n---\nb: 2\n');

    const result = await validateSyntax('/project/config.yml', {});

    expect(result.tool).toBe('yaml_parse');
    expect(result.errors).toHaveLength(0);
  });
});

describe('TOML (.toml)', () => {
  it('合法 TOML 返回空 errors', async () => {
    mockInvoke.mockResolvedValue(shellOk());

    const result = await validateSyntax('/project/pyproject.toml', {});

    expect(result.tool).toBe('toml_parse');
    expect(result.checked).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('TOML 语法错误返回行列号', async () => {
    const stderr = 'tomllib.TOMLDecodeError: Invalid value (at line 3, column 8)';
    mockInvoke.mockResolvedValue(shellFail('', stderr));

    const result = await validateSyntax('/project/pyproject.toml', {});

    expect(result.tool).toBe('toml_parse');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.line).toBe(3);
    expect(result.errors[0]!.column).toBe(8);
  });

  it('tomllib/tomli 不可用时返回 checked=false，不触发括号兜底', async () => {
    mockInvoke.mockResolvedValue(shellFail('', 'ModuleNotFoundError: No module named tomli'));

    const result = await validateSyntax('/project/config.toml', {});

    expect(result.checked).toBe(false);
    expect(result.tool).toBe('none');
  });
});

// ══════════════════════════════════════════════════════════
// 不支持的语言
// ══════════════════════════════════════════════════════════
describe('不支持的语言', () => {
  it('无扩展名文件返回 checked=false，不调用 invoke', async () => {
    const result = await validateSyntax('/project/Makefile', {});

    expect(result.checked).toBe(false);
    expect(result.tool).toBe('none');
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('.css 返回 checked=false', async () => {
    const result = await validateSyntax('/project/styles.css', {});

    expect(result.checked).toBe(false);
    expect(result.tool).toBe('none');
  });
});

// ══════════════════════════════════════════════════════════
// Rust (.rs)
// ══════════════════════════════════════════════════════════
describe('Rust (.rs)', () => {
  it('有 Cargo.toml 时优先运行 cargo check，并区分当前文件和 related 诊断', async () => {
    mockInvoke.mockImplementation(async (command, args) => {
      const invokeArgs = getInvokeArgs(args);
      if (command === 'file_read_content') {
        const filePath = normalizeTestPath(getInvokeStringArg(invokeArgs, 'filePath'));
        if (filePath.endsWith('/project/Cargo.toml')) return '[package]\nname = "demo"';
        throw new Error('not found');
      }

      const shellCommand = getInvokeStringArg(invokeArgs, 'command');
      expect(shellCommand).toBe('cargo check --message-format=json');
      return shellFail(
        [
          cargoMessage('src/lib.rs', 5, 9, 'mismatched types'),
          cargoMessage('src/main.rs', 12, 3, 'unresolved import'),
        ].join('\n'),
        ''
      );
    });

    const result = await validateSyntax('/project/src/lib.rs', {});

    expect(result.tool).toBe('cargo_check');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.filePath).toBe('src/lib.rs');
    expect(result.relatedErrors).toHaveLength(1);
    expect(result.relatedErrors?.[0]?.filePath).toBe('src/main.rs');
    expect(result.projectErrorCount).toBe(2);
  });

  it('cargo check 异常时降级为 rustc', async () => {
    mockInvoke.mockImplementation(async (command, args) => {
      const invokeArgs = getInvokeArgs(args);
      if (command === 'file_read_content') {
        const filePath = normalizeTestPath(getInvokeStringArg(invokeArgs, 'filePath'));
        if (filePath.endsWith('/project/Cargo.toml')) return '[package]\nname = "demo"';
        throw new Error('not found');
      }

      const shellCommand = getInvokeStringArg(invokeArgs, 'command');
      if (shellCommand.startsWith('cargo check')) throw new Error('cargo unavailable');
      return shellFail('', ['error[E0308]: mismatched types', ' --> src/lib.rs:7:4'].join('\n'));
    });

    const result = await validateSyntax('/project/src/lib.rs', {});

    expect(result.tool).toBe('rustc');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.line).toBe(7);
  });

  it('cargo check 和 rustc 都异常时降级为括号配对', async () => {
    mockInvoke.mockImplementation(async (command, args) => {
      const invokeArgs = getInvokeArgs(args);
      if (command === 'file_read_content') {
        const filePath = normalizeTestPath(getInvokeStringArg(invokeArgs, 'filePath'));
        if (filePath.endsWith('/project/Cargo.toml')) return '[package]\nname = "demo"';
        if (filePath.endsWith('/project/src/lib.rs')) return 'fn main() { println!("ok"); }';
        throw new Error('not found');
      }
      throw new Error('tool unavailable');
    });

    const result = await validateSyntax('/project/src/lib.rs', {});

    expect(result.tool).toBe('bracket_fallback');
    expect(result.errors).toHaveLength(0);
  });

  it('.rs 路由到 rustc，无错误时返回空 errors', async () => {
    mockInvoke.mockImplementation(async (command, _args) => {
      if (command === 'file_read_content') throw new Error('not found');
      return shellOk();
    });

    const result = await validateSyntax('/project/src/lib.rs', {});

    expect(result.tool).toBe('rustc');
    expect(result.checked).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('解析 rustc 标准格式：error[Exxxx] + --> 行', async () => {
    const stderr = [
      'error[E0308]: mismatched types',
      ' --> src/main.rs:5:10',
      '  |',
      '5 |     let x: i32 = "hello";',
      '  |                  ^^^^^^^ expected `i32`, found `&str`',
    ].join('\n');
    mockInvoke.mockImplementation(async (command, _args) => {
      if (command === 'file_read_content') throw new Error('not found');
      return shellFail('', stderr);
    });

    const result = await validateSyntax('/project/src/main.rs', {});

    expect(result.tool).toBe('rustc');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.filePath).toBe('src/main.rs');
    expect(result.errors[0]!.line).toBe(5);
    expect(result.errors[0]!.column).toBe(10);
    expect(result.errors[0]!.message).toContain('mismatched types');
  });

  it('无 --> 行时兜底提取第一条 error 消息（行号=0）', async () => {
    // 极端情况：rustc 输出摘要行但没有 --> 位置行
    const stderr = 'error: could not compile `mylib` due to previous error';
    mockInvoke.mockImplementation(async (command, _args) => {
      if (command === 'file_read_content') throw new Error('not found');
      return shellFail('', stderr);
    });

    const result = await validateSyntax('/project/lib.rs', {});

    expect(result.tool).toBe('rustc');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.line).toBe(0);
    expect(result.errors[0]!.message).toContain('could not compile');
  });

  it('多条错误时只返回前 5 条', async () => {
    // 构造 6 条 error[Exxxx] + --> 行配对
    const pairs = Array.from(
      { length: 6 },
      (_, i) => `error[E${1000 + i}]: error ${i}\n --> src/file.rs:${i + 1}:1`
    ).join('\n');
    mockInvoke.mockImplementation(async (command, _args) => {
      if (command === 'file_read_content') throw new Error('not found');
      return shellFail('', pairs);
    });

    const result = await validateSyntax('/project/src/file.rs', {});

    expect(result.tool).toBe('rustc');
    expect(result.errors.length).toBe(5);
  });

  it('rustc throw 后降级为括号配对兜底（无错误内容）', async () => {
    mockInvoke.mockImplementation(async (command, args) => {
      const invokeArgs = getInvokeArgs(args);
      if (command === 'file_read_content') {
        const filePath = normalizeTestPath(getInvokeStringArg(invokeArgs, 'filePath'));
        if (filePath.endsWith('/project/src/main.rs')) return 'fn main() { println!("hello"); }';
        throw new Error('not found');
      }
      throw new Error('timeout');
    });

    const result = await validateSyntax('/project/src/main.rs', {});

    expect(result.tool).toBe('bracket_fallback');
    expect(result.errors).toHaveLength(0);
  });

  it('rustc 降级，含未闭合括号时括号配对正确报错', async () => {
    mockInvoke.mockImplementation(async (command, args) => {
      const invokeArgs = getInvokeArgs(args);
      if (command === 'file_read_content') {
        const filePath = normalizeTestPath(getInvokeStringArg(invokeArgs, 'filePath'));
        if (filePath.endsWith('/project/src/broken.rs')) return 'fn main() {\n    let x = 1;\n';
        throw new Error('not found');
      }
      throw new Error('timeout');
    });

    const result = await validateSyntax('/project/src/broken.rs', {});

    expect(result.tool).toBe('bracket_fallback');
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ══════════════════════════════════════════════════════════
// Go (.go)
// ══════════════════════════════════════════════════════════
describe('Go (.go)', () => {
  it('有 go.mod 时运行当前 package 的 go test，并区分 current/related 诊断', async () => {
    mockInvoke.mockImplementation(async (command, args) => {
      const invokeArgs = getInvokeArgs(args);
      if (command === 'file_read_content') {
        const filePath = normalizeTestPath(getInvokeStringArg(invokeArgs, 'filePath'));
        if (filePath.endsWith('/project/go.mod')) return 'module example.com/demo';
        throw new Error('not found');
      }

      const shellCommand = getInvokeStringArg(invokeArgs, 'command');
      expect(shellCommand).toContain('go test -run=__agentvis_post_write_no_tests__ -vet=off');
      expect(shellCommand).toContain('"./internal/app"');
      return shellFail(
        [
          'internal/app/main.go:10:5: undefined: missing',
          'internal/app/other.go:3: cannot use value',
        ].join('\n'),
        ''
      );
    });

    const result = await validateSyntax('/project/internal/app/main.go', {});

    expect(result.tool).toBe('go_test');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.line).toBe(10);
    expect(result.relatedErrors).toHaveLength(1);
    expect(result.projectErrorCount).toBe(2);
  });

  it('go test 异常时降级为 gofmt', async () => {
    const shellCommands: string[] = [];
    mockInvoke.mockImplementation(async (command, args) => {
      const invokeArgs = getInvokeArgs(args);
      if (command === 'file_read_content') {
        const filePath = normalizeTestPath(getInvokeStringArg(invokeArgs, 'filePath'));
        if (filePath.endsWith('/project/go.mod')) return 'module example.com/demo';
        throw new Error('not found');
      }

      const shellCommand = getInvokeStringArg(invokeArgs, 'command');
      shellCommands.push(shellCommand);
      if (shellCommand.startsWith('go test')) throw new Error('go unavailable');
      return shellOk('package main\n\nfunc main() {}\n');
    });

    const result = await validateSyntax('/project/main.go', {});

    expect(result.tool).toBe('gofmt');
    expect(result.errors).toHaveLength(0);
    expect(shellCommands.some((command) => command.startsWith('go test'))).toBe(true);
    expect(shellCommands.some((command) => command.startsWith('gofmt'))).toBe(true);
  });

  it('无 go.mod/go.work 时直接降级为 gofmt', async () => {
    const shellCommands: string[] = [];
    mockInvoke.mockImplementation(async (command, args) => {
      const invokeArgs = getInvokeArgs(args);
      if (command === 'file_read_content') throw new Error('not found');

      const shellCommand = getInvokeStringArg(invokeArgs, 'command');
      shellCommands.push(shellCommand);
      return shellOk('package main\n\nfunc main() {}\n');
    });

    const result = await validateSyntax('/project/main.go', {});

    expect(result.tool).toBe('gofmt');
    expect(shellCommands).toHaveLength(1);
    expect(shellCommands[0]).toContain('gofmt -e');
  });

  it('.go 路由到 gofmt，无错误时返回空 errors', async () => {
    mockInvoke.mockResolvedValue(shellOk('package main\n\nfunc main() {}\n'));

    const result = await validateSyntax('/project/main.go', {});

    expect(result.tool).toBe('gofmt');
    expect(result.checked).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('解析 gofmt -e 标准错误格式（file:行:列: 消息）写到 stderr', async () => {
    const stderr = "/project/main.go:10:5: expected ';', found '}'";
    mockInvoke.mockResolvedValue(shellFail('', stderr));

    const result = await validateSyntax('/project/main.go', {});

    expect(result.tool).toBe('gofmt');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.line).toBe(10);
    expect(result.errors[0]!.column).toBe(5);
    expect(result.errors[0]!.message).toContain("expected ';'");
  });

  it('同时扫描 stdout 中的错误（兼容不同 Go 版本行为）', async () => {
    // 某些 Go 版本将错误写到 stdout
    const stdout = "main.go:3:1: expected declaration, found '}'";
    mockInvoke.mockResolvedValue(shellFail(stdout, ''));

    const result = await validateSyntax('/project/main.go', {});

    expect(result.tool).toBe('gofmt');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.line).toBe(3);
  });

  it('多条错误只返回前 5 条', async () => {
    const lines = Array.from({ length: 7 }, (_, i) => `main.go:${i + 1}:1: error ${i}`).join('\n');
    mockInvoke.mockResolvedValue(shellFail('', lines));

    const result = await validateSyntax('/project/main.go', {});

    expect(result.tool).toBe('gofmt');
    expect(result.errors.length).toBe(5);
  });

  it('gofmt throw 后降级为括号配对兜底', async () => {
    mockInvoke.mockImplementation(async (command, args) => {
      const invokeArgs = getInvokeArgs(args);
      if (command === 'file_read_content') {
        const filePath = normalizeTestPath(getInvokeStringArg(invokeArgs, 'filePath'));
        if (filePath.endsWith('/project/main.go')) return 'package main\n\nfunc main() { return }';
        throw new Error('not found');
      }
      throw new Error('gofmt not found');
    });

    const result = await validateSyntax('/project/main.go', {});

    expect(result.tool).toBe('bracket_fallback');
    expect(result.errors).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════
// 括号配对降级兜底
// ══════════════════════════════════════════════════════════
describe('括号配对降级兜底', () => {
  it('含未闭合括号时报错', async () => {
    let callCount = 0;
    mockInvoke.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('timeout');
      // 有未闭合的 [ ，且不在字符串/注释中
      return 'const arr = [\n  1,\n  2\n// 缺少 ]';
    });

    const result = await validateSyntax('/tmp/broken.py', {});

    expect(result.tool).toBe('bracket_fallback');
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('括号平衡时无错误', async () => {
    let callCount = 0;
    mockInvoke.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('timeout');
      return 'x = { "a": [1, 2], "b": (3 + 4) }\n';
    });

    const result = await validateSyntax('/tmp/ok.py', {});

    expect(result.tool).toBe('bracket_fallback');
    expect(result.errors).toHaveLength(0);
  });

  it('file_read_content 也失败时返回 checked=false', async () => {
    mockInvoke.mockRejectedValue(new Error('all fail'));

    const result = await validateSyntax('/tmp/gone.py', {});

    expect(result.checked).toBe(false);
    expect(result.tool).toBe('none');
  });
});
