/**
 * ContractValidator 单元测试
 *
 * 覆盖场景：
 * - Contract 验证（完整/缺失字段/非法值）
 * - 参数验证（必填/类型/未知参数）
 * - 名称验证（格式/冲突检测）
 */

import { describe, it, expect } from 'vitest';
import {
  validateContract,
  validateArgs,
  normalizeArgsForContract,
  isNativeSkillConflict,
  isValidSkillName,
} from '../ContractValidator';
import type { ExternalSkillFrontmatter, ExecutionContract } from '../types';

// ==================== validateContract 测试 ====================

describe('validateContract', () => {
  it('应该成功验证完整的 Contract', () => {
    const frontmatter: ExternalSkillFrontmatter = {
      name: 'csv-analyzer',
      description: '分析 CSV 文件',
      execution: {
        runtime: 'python',
        entry: 'scripts/analyze.py',
        timeout: 60,
        maxOutput: 32768,
        argsSchema: [
          {
            name: 'file_path',
            type: 'string',
            required: true,
            description: 'CSV 文件路径',
          },
        ],
      },
    };

    const result = validateContract(frontmatter);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.contract.runtime).toBe('python');
      expect(result.contract.entry).toBe('scripts/analyze.py');
      expect(result.contract.timeout).toBe(60);
      expect(result.contract.maxOutput).toBe(32768);
      expect(result.contract.argsSchema).toHaveLength(1);
    }
  });

  it('应该为缺省字段填充默认值', () => {
    const frontmatter: ExternalSkillFrontmatter = {
      name: 'simple-tool',
      description: '简单工具',
      execution: {
        runtime: 'bash',
        entry: 'run.sh',
      },
    };

    const result = validateContract(frontmatter);
    expect(result.valid).toBe(true);
    if (result.valid) {
      // 默认值
      expect(result.contract.timeout).toBe(60);
      expect(result.contract.maxOutput).toBe(65536);
      expect(result.contract.argsSchema).toEqual([]);
    }
  });

  it('应该保留网络权限声明', () => {
    const frontmatter: ExternalSkillFrontmatter = {
      name: 'network-tool',
      description: '需要访问网络的工具',
      execution: {
        runtime: 'python',
        entry: 'run.py',
        permissions: { network: true },
      },
    };

    const result = validateContract(frontmatter);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.contract.permissions).toEqual({ network: true });
    }
  });

  it('应该保留 brokerOnly 网络模式声明', () => {
    const frontmatter: ExternalSkillFrontmatter = {
      name: 'broker-tool',
      description: '通过 broker 访问网络的工具',
      execution: {
        runtime: 'python',
        entry: 'run.py',
        permissions: { networkMode: 'brokerOnly' },
      },
    };

    const result = validateContract(frontmatter);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.contract.permissions).toEqual({ networkMode: 'brokerOnly' });
    }
  });

  it('accepts filesystem grant declarations that reference string args', () => {
    const frontmatter: ExternalSkillFrontmatter = {
      name: 'file-tool',
      description: 'Local file helper',
      execution: {
        runtime: 'python',
        entry: 'run.py',
        permissions: {
          network: false,
          filesystem: [{ fromArg: 'path', access: 'readWrite' }],
        },
        argsSchema: [
          {
            name: 'path',
            type: 'string',
            required: true,
            description: 'Target path',
          },
        ],
      },
    };

    const result = validateContract(frontmatter);

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.contract.permissions?.filesystem).toEqual([
        { fromArg: 'path', access: 'readWrite' },
      ]);
    }
  });

  it('rejects filesystem grants that reference non-string args', () => {
    const frontmatter: ExternalSkillFrontmatter = {
      name: 'file-tool',
      description: 'Local file helper',
      execution: {
        runtime: 'python',
        entry: 'run.py',
        permissions: {
          network: false,
          filesystem: [{ fromArg: 'count', access: 'readWrite' }],
        },
        argsSchema: [
          {
            name: 'count',
            type: 'number',
            required: true,
            description: 'Count',
          },
        ],
      },
    };

    const result = validateContract(frontmatter);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.join('\n')).toContain(
        'permissions.filesystem[0].fromArg must reference a string argsSchema field'
      );
    }
  });

  it('accepts brokerOnly credential policy declarations', () => {
    const frontmatter: ExternalSkillFrontmatter = {
      name: 'github-tool',
      description: 'GitHub broker helper',
      execution: {
        runtime: 'python',
        entry: 'run.py',
        permissions: { network: true, networkMode: 'brokerOnly' },
        credentials: [
          {
            id: 'github',
            provider: 'github',
            mode: 'brokerAuth',
            hosts: ['api.github.com'],
            headerName: 'Authorization',
            headerValuePrefix: 'Bearer ',
            required: false,
          },
        ],
      },
    };

    const result = validateContract(frontmatter);

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.contract.credentials).toEqual([
        {
          id: 'github',
          provider: 'github',
          mode: 'brokerAuth',
          hosts: ['api.github.com'],
          headerName: 'Authorization',
          headerValuePrefix: 'Bearer ',
          required: false,
        },
      ]);
    }
  });

  it('rejects credential policies outside brokerOnly mode', () => {
    const frontmatter: ExternalSkillFrontmatter = {
      name: 'bad-credential-mode',
      description: 'Bad credential mode',
      execution: {
        runtime: 'python',
        entry: 'run.py',
        permissions: { network: true },
        credentials: [
          {
            id: 'github',
            provider: 'github',
            mode: 'brokerAuth',
            hosts: ['api.github.com'],
            headerName: 'Authorization',
            headerValuePrefix: 'Bearer ',
            required: false,
          },
        ],
      },
    };

    const result = validateContract(frontmatter);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContain(
        'execution.credentials requires execution.permissions.networkMode=brokerOnly'
      );
    }
  });

  it('rejects malformed broker credential policies', () => {
    const frontmatter: ExternalSkillFrontmatter = {
      name: 'bad-credential-policy',
      description: 'Bad credential policy',
      execution: {
        runtime: 'python',
        entry: 'run.py',
        permissions: { networkMode: 'brokerOnly' },
        credentials: [
          {
            id: 'github',
            provider: '',
            mode: 'env',
            hosts: ['*.github.com'],
            headerName: 'Proxy-Authorization',
            headerValuePrefix: 'Bearer\r\n',
          } as unknown as NonNullable<ExecutionContract['credentials']>[number],
        ],
      },
    };

    const result = validateContract(frontmatter);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      const errors = result.errors.join('\n');
      expect(errors).toContain('provider must contain only');
      expect(errors).toContain('mode must be brokerAuth');
      expect(errors).toContain('hosts must be exact host names');
      expect(errors).toContain('headerName must be a safe HTTP header name');
      expect(errors).toContain('headerValuePrefix must be a string without CR/LF');
      expect(errors).toContain('required must be boolean');
    }
  });

  it('应该保留桌面控制权限声明', () => {
    const frontmatter: ExternalSkillFrontmatter = {
      name: 'desktop-tool',
      description: '需要控制桌面的工具',
      execution: {
        runtime: 'python',
        entry: 'run.py',
        permissions: { desktopControl: true },
      },
    };

    const result = validateContract(frontmatter);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.contract.permissions).toEqual({ desktopControl: true });
    }
  });

  it('permissions.network 非布尔值时应该失败', () => {
    const frontmatter: ExternalSkillFrontmatter = {
      name: 'bad-permissions',
      description: '权限声明错误',
      execution: {
        runtime: 'python',
        entry: 'run.py',
        permissions: { network: 'yes' } as unknown as ExecutionContract['permissions'],
      },
    };

    const result = validateContract(frontmatter);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContain('execution.permissions.network must be a boolean');
    }
  });

  it('permissions.networkMode 非支持值时应该失败', () => {
    const frontmatter: ExternalSkillFrontmatter = {
      name: 'bad-network-mode',
      description: '网络模式声明错误',
      execution: {
        runtime: 'python',
        entry: 'run.py',
        permissions: { networkMode: 'proxy' } as unknown as ExecutionContract['permissions'],
      },
    };

    const result = validateContract(frontmatter);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContain(
        'execution.permissions.networkMode must be direct or brokerOnly'
      );
    }
  });

  it('permissions.network=false 与 brokerOnly 同时声明时应该失败', () => {
    const frontmatter: ExternalSkillFrontmatter = {
      name: 'conflicting-network-mode',
      description: '网络权限声明冲突',
      execution: {
        runtime: 'python',
        entry: 'run.py',
        permissions: { network: false, networkMode: 'brokerOnly' },
      },
    };

    const result = validateContract(frontmatter);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContain(
        'execution.permissions.network=false conflicts with networkMode=brokerOnly'
      );
    }
  });

  it('permissions.desktopLaunch 非布尔值时应该失败', () => {
    const frontmatter: ExternalSkillFrontmatter = {
      name: 'bad-desktop-permissions',
      description: '权限声明错误',
      execution: {
        runtime: 'python',
        entry: 'run.py',
        permissions: { desktopLaunch: 'yes' } as unknown as ExecutionContract['permissions'],
      },
    };

    const result = validateContract(frontmatter);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContain('execution.permissions.desktopLaunch must be a boolean');
    }
  });

  it('permissions.desktopControl 非布尔值时应该失败', () => {
    const frontmatter: ExternalSkillFrontmatter = {
      name: 'bad-desktop-control-permissions',
      description: '权限声明错误',
      execution: {
        runtime: 'python',
        entry: 'run.py',
        permissions: { desktopControl: 'yes' } as unknown as ExecutionContract['permissions'],
      },
    };

    const result = validateContract(frontmatter);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContain('execution.permissions.desktopControl must be a boolean');
    }
  });

  it('缺少 execution 字段时应该失败', () => {
    const frontmatter: ExternalSkillFrontmatter = {
      name: 'no-contract',
      description: '没有 Contract',
    };

    const result = validateContract(frontmatter);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContain(
        'Missing execution field; Script-mode Skill must declare an Execution Contract'
      );
    }
  });

  it('缺少 runtime 时应该失败', () => {
    const frontmatter: ExternalSkillFrontmatter = {
      name: 'no-runtime',
      description: '缺少 runtime',
      execution: {
        entry: 'scripts/run.py',
      },
    };

    const result = validateContract(frontmatter);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContain('Missing execution.runtime field');
    }
  });

  it('不支持的 runtime 应该失败', () => {
    const frontmatter: ExternalSkillFrontmatter = {
      name: 'bad-runtime',
      description: '不支持的 runtime',
      execution: {
        runtime: 'ruby' as 'python',
        entry: 'run.rb',
      },
    };

    const result = validateContract(frontmatter);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0]).toContain('Unsupported runtime');
    }
  });

  it('缺少 entry 时应该失败', () => {
    const frontmatter: ExternalSkillFrontmatter = {
      name: 'no-entry',
      description: '缺少入口',
      execution: {
        runtime: 'python',
      },
    };

    const result = validateContract(frontmatter);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContain('Missing execution.entry field (entry script path)');
    }
  });

  it('应该拒绝不安全的 entry 路径', () => {
    for (const entry of ['../run.py', 'C:/tools/run.py', 'scripts/run".py']) {
      const frontmatter: ExternalSkillFrontmatter = {
        name: 'unsafe-entry',
        description: 'Unsafe entry',
        execution: {
          runtime: 'python',
          entry,
        },
      };

      const result = validateContract(frontmatter);

      expect(result.valid).toBe(false);
    }
  });

  it('timeout 超过上限应该失败', () => {
    const frontmatter: ExternalSkillFrontmatter = {
      name: 'long-timeout',
      description: '超长超时',
      execution: {
        runtime: 'python',
        entry: 'run.py',
        timeout: 600,
      },
    };

    const result = validateContract(frontmatter);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0]).toContain('cannot exceed 300 seconds');
    }
  });

  it('longRunning skill 应该允许更长 timeout', () => {
    const frontmatter: ExternalSkillFrontmatter = {
      name: 'long-running-video',
      description: '长时间视频任务',
      execution: {
        runtime: 'python',
        entry: 'run.py',
        timeout: 600,
        permissions: {
          longRunning: true,
        },
      },
    };

    const result = validateContract(frontmatter);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.contract.timeout).toBe(600);
    }
  });

  it('longRunning skill 应该允许 1800 秒统一上限', () => {
    const frontmatter: ExternalSkillFrontmatter = {
      name: 'max-long-running',
      description: '长时间任务',
      execution: {
        runtime: 'python',
        entry: 'run.py',
        timeout: 1800,
        permissions: {
          longRunning: true,
        },
      },
    };

    const result = validateContract(frontmatter);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.contract.timeout).toBe(1800);
    }
  });

  it('longRunning timeout 超过统一上限应该失败', () => {
    const frontmatter: ExternalSkillFrontmatter = {
      name: 'too-long-running',
      description: '过长任务',
      execution: {
        runtime: 'python',
        entry: 'run.py',
        timeout: 1801,
        permissions: {
          longRunning: true,
        },
      },
    };

    const result = validateContract(frontmatter);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0]).toContain('cannot exceed 1800 seconds');
    }
  });

  it('argsSchema 中有重复 name 应该失败', () => {
    const frontmatter: ExternalSkillFrontmatter = {
      name: 'dup-args',
      description: '重复参数',
      execution: {
        runtime: 'python',
        entry: 'run.py',
        argsSchema: [
          { name: 'file', type: 'string', required: true, description: '文件' },
          { name: 'file', type: 'number', required: false, description: '又一个文件' },
        ],
      },
    };

    const result = validateContract(frontmatter);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('duplicate'))).toBe(true);
    }
  });

  it('argsSchema 中有不安全 name 应该失败', () => {
    const frontmatter: ExternalSkillFrontmatter = {
      name: 'unsafe-args',
      description: 'Unsafe args',
      execution: {
        runtime: 'python',
        entry: 'run.py',
        argsSchema: [
          { name: 'good_name', type: 'string', required: true, description: 'Good' },
          { name: 'bad name', type: 'string', required: false, description: 'Bad' },
          { name: 'also"bad', type: 'number', required: false, description: 'Bad' },
        ],
      },
    };

    const result = validateContract(frontmatter);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.filter((e) => e.includes('name must start'))).toHaveLength(2);
    }
  });

  it('应接受本地参数约束元数据', () => {
    const frontmatter: ExternalSkillFrontmatter = {
      name: 'constrained-args',
      description: 'Constrained args',
      execution: {
        runtime: 'python',
        entry: 'run.py',
        argsSchema: [
          {
            name: 'action',
            type: 'string',
            required: true,
            description: 'Action',
            allowedValues: ['search', 'read'],
            default: 'search',
            examples: ['search'],
          },
          {
            name: 'limit',
            type: 'number',
            required: false,
            description: 'Limit',
            min: 1,
            max: 50,
            default: 10,
            examples: [5, 10],
          },
        ],
      },
    };

    const result = validateContract(frontmatter);

    expect(result.valid).toBe(true);
  });

  it('应拒绝不合法的本地参数约束元数据', () => {
    const frontmatter: ExternalSkillFrontmatter = {
      name: 'bad-constraints',
      description: 'Bad constraints',
      execution: {
        runtime: 'python',
        entry: 'run.py',
        argsSchema: [
          {
            name: 'action',
            type: 'string',
            required: true,
            description: 'Action',
            allowedValues: ['search'],
            default: 'read',
          },
          {
            name: 'mode',
            type: 'boolean',
            required: false,
            description: 'Mode',
            min: 1,
          },
          {
            name: 'limit',
            type: 'number',
            required: false,
            description: 'Limit',
            min: 20,
            max: 10,
            examples: ['ten'],
          },
        ],
      },
    };

    const result = validateContract(frontmatter);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      const errors = result.errors.join('\n');
      expect(errors).toContain('default must be included in allowedValues');
      expect(errors).toContain('min and max are only valid for number args');
      expect(errors).toContain('min cannot be greater than max');
      expect(errors).toContain('examples entries must match type number');
    }
  });

  it('应该支持所有有效的 runtime 类型', () => {
    for (const runtime of ['python', 'bash', 'node'] as const) {
      const frontmatter: ExternalSkillFrontmatter = {
        name: `test-${runtime}`,
        description: `测试 ${runtime}`,
        execution: {
          runtime,
          entry: `run.${runtime === 'python' ? 'py' : runtime === 'bash' ? 'sh' : 'js'}`,
        },
      };

      const result = validateContract(frontmatter);
      expect(result.valid).toBe(true);
    }
  });
});

// ==================== validateArgs 测试 ====================

describe('validateArgs', () => {
  const contract: ExecutionContract = {
    runtime: 'python',
    entry: 'run.py',
    timeout: 30,
    maxOutput: 65536,
    argsSchema: [
      { name: 'file_path', type: 'string', required: true, description: '文件路径' },
      { name: 'count', type: 'number', required: false, description: '数量' },
      { name: 'verbose', type: 'boolean', required: false, description: '详细模式' },
    ],
  };

  it('应该通过有效参数验证', () => {
    const result = validateArgs(
      { file_path: '/data/test.csv', count: 10, verbose: true },
      contract
    );
    expect(result.valid).toBe(true);
  });

  it('缺少必填参数应该失败', () => {
    const result = validateArgs({ count: 10 }, contract);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors[0]).toContain('file_path');
    }
  });

  it('参数类型错误应该失败', () => {
    const result = validateArgs({ file_path: 123, count: 'abc' }, contract);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('未知参数应该被忽略（宽容策略）', () => {
    const result = validateArgs({ file_path: '/data/test.csv', unknown_param: 'hello' }, contract);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors).toContain('Unknown argument: unknown_param');
    }
  });

  it('仅传可选参数也应该失败（缺少必填）', () => {
    const result = validateArgs({ verbose: true }, contract);
    expect(result.valid).toBe(false);
  });

  it('应校验 allowedValues 和数字范围', () => {
    const constrainedContract: ExecutionContract = {
      runtime: 'python',
      entry: 'run.py',
      timeout: 30,
      maxOutput: 65536,
      argsSchema: [
        {
          name: 'action',
          type: 'string',
          required: true,
          description: 'Action',
          allowedValues: ['search', 'read'],
        },
        {
          name: 'limit',
          type: 'number',
          required: false,
          description: 'Limit',
          min: 1,
          max: 10,
        },
      ],
    };

    expect(validateArgs({ action: 'search', limit: 5 }, constrainedContract).valid).toBe(true);

    const invalidAction = validateArgs({ action: 'delete', limit: 5 }, constrainedContract);
    expect(invalidAction.valid).toBe(false);
    if (!invalidAction.valid) {
      expect(invalidAction.errors[0]).toContain('must be one of');
    }

    const invalidLimit = validateArgs({ action: 'search', limit: 50 }, constrainedContract);
    expect(invalidLimit.valid).toBe(false);
    if (!invalidLimit.valid) {
      expect(invalidLimit.errors[0]).toContain('<= 10');
    }
  });

  it('应拒绝 NaN 和 Infinity 数字参数', () => {
    const nanResult = validateArgs({ file_path: '/data/test.csv', count: Number.NaN }, contract);
    expect(nanResult.valid).toBe(false);
    if (!nanResult.valid) {
      expect(nanResult.errors).toContain('Argument count must be a finite number');
    }

    const infinityResult = validateArgs({ file_path: '/data/test.csv', count: Infinity }, contract);
    expect(infinityResult.valid).toBe(false);
  });
});

describe('normalizeArgsForContract', () => {
  const contract: ExecutionContract = {
    runtime: 'python',
    entry: 'run.py',
    timeout: 30,
    maxOutput: 65536,
    argsSchema: [
      { name: 'file_path', type: 'string', required: true, description: 'file path' },
      { name: 'count', type: 'number', required: false, description: 'count' },
      { name: 'ratio', type: 'number', required: false, description: 'ratio' },
      { name: 'verbose', type: 'boolean', required: false, description: 'verbose' },
    ],
  };

  it('coerces numeric and boolean strings for declared args', () => {
    const original = {
      file_path: '/data/test.csv',
      count: '10',
      ratio: ' 3.5 ',
      verbose: 'false',
      unknown: '42',
    };

    const result = normalizeArgsForContract(original, contract);

    expect(result.args).toEqual({
      file_path: '/data/test.csv',
      count: 10,
      ratio: 3.5,
      verbose: false,
      unknown: '42',
    });
    expect(result.changedKeys).toEqual(['count', 'ratio', 'verbose']);
    expect(original.count).toBe('10');
  });

  it('leaves unsafe numeric strings unchanged so validation can reject them', () => {
    const result = normalizeArgsForContract(
      { file_path: '/data/test.csv', count: '10 papers', verbose: 'yes' },
      contract
    );

    expect(result.args.count).toBe('10 papers');
    expect(result.args.verbose).toBe('yes');
    expect(validateArgs(result.args, contract).valid).toBe(false);
  });
});

// ==================== isNativeSkillConflict 测试 ====================

describe('isNativeSkillConflict', () => {
  it('应该检测到 Native Skill 冲突', () => {
    expect(isNativeSkillConflict('read')).toBe(true);
    expect(isNativeSkillConflict('file_write')).toBe(true);
    expect(isNativeSkillConflict('exec')).toBe(true);
    expect(isNativeSkillConflict('web_search')).toBe(true);
    expect(isNativeSkillConflict('local_search')).toBe(true);
    expect(isNativeSkillConflict('conversation_search')).toBe(true);
    expect(isNativeSkillConflict('generate_image')).toBe(true);
    expect(isNativeSkillConflict('cron')).toBe(true);
    expect(isNativeSkillConflict('im_send')).toBe(true);
    expect(isNativeSkillConflict('feishu_send')).toBe(true);
    expect(isNativeSkillConflict('slack_send')).toBe(true);
    expect(isNativeSkillConflict('external_skill_execute')).toBe(true);
  });

  it('非 Native 名称不应冲突', () => {
    expect(isNativeSkillConflict('csv-analyzer')).toBe(false);
    expect(isNativeSkillConflict('my-tool')).toBe(false);
  });
});

// ==================== isValidSkillName 测试 ====================

describe('isValidSkillName', () => {
  it('应该接受合法名称', () => {
    expect(isValidSkillName('csv-analyzer')).toBe(true);
    expect(isValidSkillName('tool1')).toBe(true);
    expect(isValidSkillName('a')).toBe(true);
    expect(isValidSkillName('my-long-tool-name')).toBe(true);
  });

  it('应该拒绝非法名称', () => {
    expect(isValidSkillName('-leading')).toBe(false);
    expect(isValidSkillName('trailing-')).toBe(false);
    expect(isValidSkillName('HAS_UPPER')).toBe(false);
    expect(isValidSkillName('has space')).toBe(false);
    expect(isValidSkillName('')).toBe(false);
  });
});
