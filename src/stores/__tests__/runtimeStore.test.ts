/**
 * RuntimeStore 单元测试
 *
 * 覆盖场景：
 * - 环境状态流转（not_checked → creating → ready）
 * - 物理状态 reconcile（持久化状态 vs venv 物理存在）
 * - 待安装依赖增删
 * - markSkipped / clearError / reset
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.hoisted 确保此块在所有 ESM import 之前执行
// Zustand persist 的 createJSONStorage(() => localStorage) 在 store import 时求值，
// 因此 localStorage 必须在 import 之前可用
vi.hoisted(() => {
  const memoryStorage: Record<string, string> = {};
  globalThis.localStorage = {
    getItem: (key: string) => memoryStorage[key] ?? null,
    setItem: (key: string, value: string) => {
      memoryStorage[key] = value;
    },
    removeItem: (key: string) => {
      Reflect.deleteProperty(memoryStorage, key);
    },
    clear: () => {
      Object.keys(memoryStorage).forEach((k) => Reflect.deleteProperty(memoryStorage, k));
    },
    get length() {
      return Object.keys(memoryStorage).length;
    },
    key: (index: number) => Object.keys(memoryStorage)[index] ?? null,
  } as Storage;
});

import { useRuntimeStore } from '../runtimeStore';

// ==================== 工具函数 ====================

/** 重置 store 为干净初始状态 */
function resetStore() {
  useRuntimeStore.getState().reset();
}

// ==================== 测试 ====================

describe('RuntimeStore', () => {
  beforeEach(() => {
    resetStore();
  });

  describe('环境状态流转', () => {
    it('初始状态应为 not_checked', () => {
      const { envStatus } = useRuntimeStore.getState();
      expect(envStatus).toBe('not_checked');
    });

    it('setEnvStatus 应正确更新状态', () => {
      const { setEnvStatus } = useRuntimeStore.getState();

      setEnvStatus('creating');
      expect(useRuntimeStore.getState().envStatus).toBe('creating');

      setEnvStatus('installing_base');
      expect(useRuntimeStore.getState().envStatus).toBe('installing_base');

      setEnvStatus('ready');
      expect(useRuntimeStore.getState().envStatus).toBe('ready');
    });

    it('setError 应同时设置 error 状态和错误信息', () => {
      const { setError } = useRuntimeStore.getState();

      setError('Python not found');

      const state = useRuntimeStore.getState();
      expect(state.envStatus).toBe('error');
      expect(state.errorMessage).toBe('Python not found');
      expect(state.installProgress).toBeNull();
    });

    it('clearError 应清除错误信息但不重置状态', () => {
      const { setError, clearError } = useRuntimeStore.getState();

      setError('some error');
      clearError();

      const state = useRuntimeStore.getState();
      expect(state.errorMessage).toBeNull();
      // 注意：clearError 不重置 envStatus，保留 error 状态
      expect(state.envStatus).toBe('error');
    });

    it('markSkipped 应设置 skipped 状态', () => {
      const { markSkipped } = useRuntimeStore.getState();

      markSkipped();

      const state = useRuntimeStore.getState();
      expect(state.envStatus).toBe('skipped');
      expect(state.installProgress).toBeNull();
    });
  });

  describe('Python 信息管理', () => {
    it('setPythonInfo 应更新版本和路径', () => {
      const { setPythonInfo } = useRuntimeStore.getState();

      setPythonInfo('3.12.1', '/usr/bin/python3');

      const state = useRuntimeStore.getState();
      expect(state.pythonVersion).toBe('3.12.1');
      expect(state.pythonPath).toBe('/usr/bin/python3');
    });

    it('setVenvPath 应更新 venv 路径', () => {
      const { setVenvPath } = useRuntimeStore.getState();

      setVenvPath('/appdata/runtime/.venv');

      expect(useRuntimeStore.getState().venvPath).toBe('/appdata/runtime/.venv');
    });
  });

  describe('reconcileWithPhysical', () => {
    it('ready + venv 不存在 → 重置为 not_created', () => {
      const { setEnvStatus, reconcileWithPhysical } = useRuntimeStore.getState();

      setEnvStatus('ready');
      reconcileWithPhysical(false);

      const state = useRuntimeStore.getState();
      expect(state.envStatus).toBe('not_created');
      expect(state.pythonVersion).toBeNull();
    });

    it('not_checked + venv 存在 → 设为 ready', () => {
      const { reconcileWithPhysical } = useRuntimeStore.getState();

      reconcileWithPhysical(true);

      expect(useRuntimeStore.getState().envStatus).toBe('ready');
    });

    it('not_checked + venv 不存在 → 设为 not_created', () => {
      const { reconcileWithPhysical } = useRuntimeStore.getState();

      reconcileWithPhysical(false);

      expect(useRuntimeStore.getState().envStatus).toBe('not_created');
    });

    it('creating 状态不受 reconcile 影响（正在进行中）', () => {
      const { setEnvStatus, setActiveInstall, reconcileWithPhysical } = useRuntimeStore.getState();

      setEnvStatus('creating');
      // 模拟当前会话存在活跃安装进程，reconcile 应跳过中间状态重置
      setActiveInstall(true);
      reconcileWithPhysical(false);

      // 正在创建中，不应被 reconcile 重置
      expect(useRuntimeStore.getState().envStatus).toBe('creating');
    });

    it('error + runtime 不可用且有错误详情 → 保持 error', () => {
      const { setError, reconcileWithPhysical } = useRuntimeStore.getState();

      setError("ModuleNotFoundError: No module named '_ssl'");
      reconcileWithPhysical(false);

      const state = useRuntimeStore.getState();
      expect(state.envStatus).toBe('error');
      expect(state.errorMessage).toContain('_ssl');
    });

    it('error + runtime 不可用且无错误详情 → 重置为 not_created', () => {
      const { setEnvStatus, reconcileWithPhysical } = useRuntimeStore.getState();

      setEnvStatus('error');
      reconcileWithPhysical(false);

      const state = useRuntimeStore.getState();
      expect(state.envStatus).toBe('not_created');
      expect(state.errorMessage).toBeNull();
    });
  });

  describe('待安装依赖管理', () => {
    it('addPendingDependencies 应添加依赖', () => {
      const { addPendingDependencies } = useRuntimeStore.getState();

      addPendingDependencies({
        skillName: 'pptx',
        packages: ['python-pptx>=0.6'],
      });

      const deps = useRuntimeStore.getState().pendingDependencies;
      expect(deps).toHaveLength(1);
      expect(deps[0]!.skillName).toBe('pptx');
    });

    it('addPendingDependencies 应去重（同名技能覆盖）', () => {
      const { addPendingDependencies } = useRuntimeStore.getState();

      addPendingDependencies({
        skillName: 'pdf',
        packages: ['PyPDF2'],
      });
      addPendingDependencies({
        skillName: 'pdf',
        packages: ['PyPDF2', 'pdfminer'],
      });

      const deps = useRuntimeStore.getState().pendingDependencies;
      expect(deps).toHaveLength(1);
      expect(deps[0]!.packages).toEqual(['PyPDF2', 'pdfminer']);
    });

    it('removePendingDependencies 应移除指定技能依赖', () => {
      const { addPendingDependencies, removePendingDependencies } = useRuntimeStore.getState();

      addPendingDependencies({ skillName: 'pdf', packages: ['PyPDF2'] });
      addPendingDependencies({ skillName: 'pptx', packages: ['python-pptx'] });

      removePendingDependencies('pdf');

      const deps = useRuntimeStore.getState().pendingDependencies;
      expect(deps).toHaveLength(1);
      expect(deps[0]!.skillName).toBe('pptx');
    });

    it('clearPendingDependencies 应清空所有依赖', () => {
      const { addPendingDependencies, clearPendingDependencies } = useRuntimeStore.getState();

      addPendingDependencies({ skillName: 'pdf', packages: ['PyPDF2'] });
      addPendingDependencies({ skillName: 'pptx', packages: ['python-pptx'] });

      clearPendingDependencies();

      expect(useRuntimeStore.getState().pendingDependencies).toHaveLength(0);
    });
  });

  describe('安装进度', () => {
    it('setInstallProgress 应更新进度', () => {
      const { setInstallProgress } = useRuntimeStore.getState();

      setInstallProgress({ phase: '创建虚拟环境', percent: 20 });

      const progress = useRuntimeStore.getState().installProgress;
      expect(progress?.phase).toBe('创建虚拟环境');
      expect(progress?.percent).toBe(20);
    });

    it('setInstallProgress(null) 应清除进度', () => {
      const { setInstallProgress } = useRuntimeStore.getState();

      setInstallProgress({ phase: 'test', percent: 50 });
      setInstallProgress(null);

      expect(useRuntimeStore.getState().installProgress).toBeNull();
    });
  });

  describe('GitHub 安装状态', () => {
    it('setGitHubInstallStatus 应更新状态', () => {
      const { setGitHubInstallStatus } = useRuntimeStore.getState();

      setGitHubInstallStatus('downloading');
      expect(useRuntimeStore.getState().githubInstallStatus).toBe('downloading');

      setGitHubInstallStatus('done');
      expect(useRuntimeStore.getState().githubInstallStatus).toBe('done');
    });

    it('setGitHubInstallError 应设置错误信息', () => {
      const { setGitHubInstallError } = useRuntimeStore.getState();

      setGitHubInstallError('Download failed');
      expect(useRuntimeStore.getState().githubInstallError).toBe('Download failed');

      setGitHubInstallError(null);
      expect(useRuntimeStore.getState().githubInstallError).toBeNull();
    });
  });

  describe('npm 后置初始化命令', () => {
    it('markPostInstallCommandCompleted 应记录完成状态并进入持久化数据', () => {
      const { markPostInstallCommandCompleted } = useRuntimeStore.getState();

      markPostInstallCommandCompleted('post-npm:agent-browser install');

      const state = useRuntimeStore.getState();
      expect(state.completedPostInstallCommands['post-npm:agent-browser install']).toBe(true);

      const persisted = localStorage.getItem('agentvis-runtime-store');
      expect(persisted).toContain('completedPostInstallCommands');
      expect(persisted).toContain('post-npm:agent-browser install');
    });
  });

  describe('reset', () => {
    it('应恢复所有字段为初始值', () => {
      const store = useRuntimeStore.getState();

      // 修改各种状态
      store.setEnvStatus('ready');
      store.setPythonInfo('3.11.5', '/usr/bin/python3');
      store.setVenvPath('/appdata/.venv');
      store.addPendingDependencies({ skillName: 'pdf', packages: ['PyPDF2'] });
      store.setInstallProgress({ phase: 'test', percent: 50 });
      store.setGitHubInstallStatus('downloading');
      store.markPostInstallCommandCompleted('post-npm:agent-browser install');

      // 重置
      store.reset();

      const after = useRuntimeStore.getState();
      expect(after.envStatus).toBe('not_checked');
      expect(after.pythonVersion).toBeNull();
      expect(after.pythonPath).toBeNull();
      expect(after.venvPath).toBeNull();
      expect(after.errorMessage).toBeNull();
      expect(after.installedSkills).toHaveLength(0);
      expect(after.pendingDependencies).toHaveLength(0);
      expect(after.installProgress).toBeNull();
      expect(after.githubInstallStatus).toBe('idle');
      expect(after.completedPostInstallCommands).toEqual({});
    });
  });
});
