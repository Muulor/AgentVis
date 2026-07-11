/**
 * ExecSafetyPolicy 单元测试
 *
 * 验证安全命令白名单的匹配正确性
 */

import { describe, it, expect } from 'vitest';
import { translate } from '@/i18n';
import { isExecCommandSafe, SAFE_EXEC_PATTERNS, isExecCommandBlocked } from '../ExecSafetyPolicy';

// ═══════════════════════════════════════════════════════════════
// 白名单常量
// ═══════════════════════════════════════════════════════════════

describe('SAFE_EXEC_PATTERNS', () => {
  it('应包含多个安全模式', () => {
    expect(SAFE_EXEC_PATTERNS.length).toBeGreaterThan(5);
  });
});

// ═══════════════════════════════════════════════════════════════
// isExecCommandSafe
// ═══════════════════════════════════════════════════════════════

describe('isExecCommandSafe', () => {
  // ── 🟢 安全命令 ──

  describe('Git 只读操作应判定为安全', () => {
    it.each([
      'git status',
      'git log --oneline -10',
      'git diff HEAD~1',
      'git branch -a',
      'git show HEAD',
      'git remote -v',
      'git tag --list',
      'git stash list',
    ])('✅ %s', (cmd) => {
      expect(isExecCommandSafe(cmd)).toBe(true);
    });
  });

  describe('文件浏览和目录导航命令应判定为安全', () => {
    it.each([
      'cd /home/user/project',
      'cd ..',
      'ls -la',
      'dir /b',
      'find . -name "*.ts"',
      'grep -r "import" src/',
      'cat package.json',
      'head -20 README.md',
      'tail -f log.txt',
      'wc -l src/**/*.ts',
      'tree src/',
      'pwd',
      'echo hello',
    ])('✅ %s', (cmd) => {
      expect(isExecCommandSafe(cmd)).toBe(true);
    });
  });

  describe('构建和测试命令应判定为安全', () => {
    it.each([
      'npm run build',
      'npm run test',
      'npm run lint',
      'npm run check',
      'npm run format',
      'npm run dev',
      'npx vitest run',
      'npx tsc --noEmit',
      'npx eslint .',
      'cargo build',
      'cargo test',
      'cargo check',
      'cargo clippy',
      'cargo fmt --check',
    ])('✅ %s', (cmd) => {
      expect(isExecCommandSafe(cmd)).toBe(true);
    });
  });

  describe('版本和信息查询应判定为安全', () => {
    it.each([
      'node -v',
      'npm --version',
      'cargo --version',
      'npm list',
      'npm ls',
      'npm outdated',
      'pip list',
      'pip show flask',
    ])('✅ %s', (cmd) => {
      expect(isExecCommandSafe(cmd)).toBe(true);
    });
  });

  describe('进程查看命令应判定为安全', () => {
    it.each(['tasklist', 'tasklist /v', 'ps aux', 'ps -ef'])('✅ %s', (cmd) => {
      expect(isExecCommandSafe(cmd)).toBe(true);
    });
  });

  describe('网络诊断命令应判定为安全', () => {
    it.each([
      'ping 127.0.0.1',
      'ping google.com',
      'netstat -an',
      'ipconfig',
      'ipconfig /all',
      'ifconfig',
      'nslookup google.com',
      'tracert google.com',
    ])('✅ %s', (cmd) => {
      expect(isExecCommandSafe(cmd)).toBe(true);
    });
  });

  // ── 🔴 高危命令 ──

  describe('安装/卸载命令应判定为高危', () => {
    it.each(['npm install lodash', 'npm i express', 'pip install flask', 'cargo add serde'])(
      '❌ %s',
      (cmd) => {
        expect(isExecCommandSafe(cmd)).toBe(false);
      }
    );
  });

  describe('Git 变更操作应判定为高危', () => {
    it.each([
      'git push origin main',
      'git commit -m "fix"',
      'git reset --hard HEAD~1',
      'git checkout main',
      'git merge feature',
      'git rebase main',
    ])('❌ %s', (cmd) => {
      expect(isExecCommandSafe(cmd)).toBe(false);
    });
  });

  describe('脚本执行应判定为安全', () => {
    it.each([
      'python script.py',
      'python3 main.py',
      'python -m http.server',
      'python -c "print(1)"',
      'node server.js',
      'node dist/index.js',
      'cmd /c start-chrome.bat',
      `cmd /c 'C:\\Users\\Admin\\scripts\\start-chrome-debug.bat' https://example.com`,
      'bash script.sh',
      'sh deploy.sh',
      'powershell -Command Get-Process',
      'powershell -File script.ps1',
    ])('✅ %s', (cmd) => {
      expect(isExecCommandSafe(cmd)).toBe(true);
    });
  });

  describe('非删除类文件操作应判定为安全', () => {
    it.each([
      'mkdir output',
      'md dist',
      'copy file1.txt file2.txt',
      'cp src/a.ts src/b.ts',
      'move old.txt new.txt',
      'rename old.ts new.ts',
      'xcopy src dest /E',
      'robocopy src dest',
    ])('✅ %s', (cmd) => {
      expect(isExecCommandSafe(cmd)).toBe(true);
    });
  });

  describe('Windows 条件存在性检查应按受限动作判定为安全', () => {
    it.each([
      'if exist Agent-Log echo exists',
      'if not exist Agent-Log echo missing',
      'if exist "Agent-Log\\2026-06-14_agent-log.md" type "Agent-Log\\2026-06-14_agent-log.md"',
      'if not exist "Agent-Log" mkdir "Agent-Log"',
      'if exist "Agent-Log" (echo exists) else (echo missing)',
    ])('✅ %s', (cmd) => {
      expect(isExecCommandSafe(cmd)).toBe(true);
    });
  });

  describe('删除操作应判定为高危', () => {
    it.each(['rm -rf node_modules', 'del /q *.tmp', 'rmdir /s /q dist'])('❌ %s', (cmd) => {
      expect(isExecCommandSafe(cmd)).toBe(false);
    });
  });

  describe('Windows 条件检查带危险后续动作时仍应判定为高危', () => {
    it.each([
      'if exist Agent-Log del Agent-Log\\old.md',
      'if exist Agent-Log echo ok & del Agent-Log\\old.md',
      'if exist Agent-Log echo ok > marker.txt',
      'if exist Agent-Log type Agent-Log\\today.md | findstr Result',
    ])('❌ %s', (cmd) => {
      expect(isExecCommandSafe(cmd)).toBe(false);
    });
  });

  describe('系统和网络操作应判定为高危', () => {
    it.each([
      'chmod 777 script.sh',
      'sudo apt-get install',
      'curl -X POST http://api.com',
      'wget http://example.com/file.zip',
      'shutdown /s',
    ])('❌ %s', (cmd) => {
      expect(isExecCommandSafe(cmd)).toBe(false);
    });
  });

  // ── 边界情况 ──

  describe('边界情况', () => {
    it('空命令应判定为高危', () => {
      expect(isExecCommandSafe('')).toBe(false);
    });

    it('纯空白命令应判定为高危', () => {
      expect(isExecCommandSafe('   ')).toBe(false);
    });

    it('未知命令应判定为高危', () => {
      expect(isExecCommandSafe('some-random-binary --flag')).toBe(false);
    });

    it('带前导空格的安全命令应正确识别', () => {
      expect(isExecCommandSafe('  git status')).toBe(true);
    });

    it('不应被命令前缀欺骗（git-status 不等于 git status）', () => {
      // 'git-status' 不是 'git status'，不应匹配
      expect(isExecCommandSafe('git-status')).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// isExecCommandBlocked — 绝对禁止命令黑名单
// ═══════════════════════════════════════════════════════════════

describe('isExecCommandBlocked', () => {
  // ── ⛔ 应被阻断的命令 ──

  describe('磁盘/分区/致命操作应被阻断', () => {
    it.each(['diskpart', 'format D:', 'format C: /fs:ntfs', 'bcdedit /set', 'cipher /w:C:\\'])(
      '⛔ %s',
      (cmd) => {
        const result = isExecCommandBlocked(cmd);
        expect(result.blocked).toBe(true);
        expect(result.reason).toContain(
          translate('tools.execSafety.blockedPrefix', { reason: '' }).trim()
        );
      }
    );
  });

  describe('文件所有权和系统管理应被阻断', () => {
    it.each([
      'takeown /f C:\\Windows\\file.dll',
      'sfc /scannow',
      'net user admin P@ss /add',
      'net stop wuauserv',
      'net start wuauserv',
      'sc delete MyService',
      'wmic process delete',
      'wmic service call create',
    ])('⛔ %s', (cmd) => {
      expect(isExecCommandBlocked(cmd).blocked).toBe(true);
    });
  });

  describe('注册表操作应被阻断', () => {
    it.each(['reg delete HKCU\\Software\\Test', 'reg add HKLM\\SYSTEM\\Environment'])(
      '⛔ %s',
      (cmd) => {
        expect(isExecCommandBlocked(cmd).blocked).toBe(true);
      }
    );
  });

  describe('编码命令应被阻断', () => {
    it.each([
      'powershell -EncodedCommand dABlAHMAdA==',
      'powershell -encodedcommand dABlAHMAdA==',
      'powershell -enc dABlAHMAdA==',
    ])('⛔ %s', (cmd) => {
      expect(isExecCommandBlocked(cmd).blocked).toBe(true);
    });
  });

  describe('系统级环境变量修改应被阻断', () => {
    it.each(['setx PATH "C:\\new" /M', 'setx /M MY_VAR value'])('⛔ %s', (cmd) => {
      expect(isExecCommandBlocked(cmd).blocked).toBe(true);
    });
  });

  describe('PowerShell 环境变量修改绕过应被阻断', () => {
    it.each([
      // .NET API — Machine 级别
      `powershell -Command "[Environment]::SetEnvironmentVariable('PATH','C:\\new','Machine')"`,
      // .NET API — User 级别
      `powershell -Command "[System.Environment]::SetEnvironmentVariable('MY_VAR','value','User')"`,
      // .NET API — 带条件判断的复合命令
      `powershell -Command "$currentPath = [Environment]::GetEnvironmentVariable('PATH', 'Machine'); [Environment]::SetEnvironmentVariable('PATH', $currentPath + ';D:\\ollama', 'Machine')"`,
      // 注册表 Set-ItemProperty
      `powershell -Command "Set-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment' -Name 'PATH' -Value 'C:\\new'"`,
      // 注册表 New-ItemProperty
      `powershell -Command "New-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment' -Name 'MY_VAR'"`,
    ])('⛔ %s', (cmd) => {
      expect(isExecCommandBlocked(cmd).blocked).toBe(true);
    });
  });

  describe('环境变量只读操作不应被阻断', () => {
    it.each([
      // $env: 读取
      `powershell -Command "$env:PATH -split ';'"`,
      // [Environment]::GetEnvironmentVariable 读取
      `powershell -Command "[Environment]::GetEnvironmentVariable('PATH','Machine')"`,
    ])('✅ %s', (cmd) => {
      expect(isExecCommandBlocked(cmd).blocked).toBe(false);
    });
  });

  describe('大小写混合应同样被阻断', () => {
    it.each(['DiskPart', 'BCDEDIT /set', 'REG DELETE HKCU\\test', 'WMIC process delete'])(
      '⛔ %s',
      (cmd) => {
        expect(isExecCommandBlocked(cmd).blocked).toBe(true);
      }
    );
  });

  describe('ACL 权限修改 + 系统目录应被阻断', () => {
    it.each([
      // icacls + /grant + System32
      'icacls C:\\Windows\\System32 /grant Everyone:F',
      // icacls + /inheritance:r + Windows
      'icacls C:\\Windows /inheritance:r',
      // icacls + /deny + syswow64
      'icacls C:\\Windows\\SysWOW64 /deny Users:R',
      // cacls + /G (grant) + System32
      'cacls C:\\Windows\\System32 /G Everyone:F',
      // cacls + /D (deny) + Windows
      'cacls C:\\Windows /D Users',
      // Set-Acl + System32
      `powershell -Command "Set-Acl -Path 'C:\\Windows\\System32\\test.dll' -AclObject $acl"`,
      // Set-Acl + $env:SystemRoot
      `powershell -Command "Set-Acl -Path $env:SystemRoot\\System32 -AclObject $acl"`,
      // Set-Acl + $env:windir
      `powershell -Command "Set-Acl -Path $env:windir\\System32 -AclObject $acl"`,
    ])('⛔ %s', (cmd) => {
      expect(isExecCommandBlocked(cmd).blocked).toBe(true);
    });
  });

  describe('ACL 只读或非系统目录操作不应被阻断', () => {
    it.each([
      // icacls 仅查看（无修改参数）
      'icacls C:\\Windows\\System32\\test.dll',
      // icacls 修改非系统目录
      'icacls F:\\project\\output /grant User:F',
      // Set-Acl 修改非系统目录
      `powershell -Command "Set-Acl -Path 'F:\\project\\output' -AclObject $acl"`,
      // Get-Acl 只读查询
      `powershell -Command "Get-Acl 'C:\\Windows\\System32'"`,
    ])('✅ %s', (cmd) => {
      expect(isExecCommandBlocked(cmd).blocked).toBe(false);
    });
  });

  // ── ✅ 不应被阻断的命令 ──

  describe('正常命令不应被阻断', () => {
    it.each([
      'git status',
      'npm run build',
      'cargo test',
      'del /q *.tmp',
      'rmdir /s /q dist',
      'npm install lodash',
      'pip install flask',
      'python script.py',
      'setx MY_VAR value',
      'wmic os get caption',
      'wmic cpu get name',
    ])('✅ %s', (cmd) => {
      expect(isExecCommandBlocked(cmd).blocked).toBe(false);
    });
  });

  describe('边界情况', () => {
    it('空命令不应被阻断', () => {
      expect(isExecCommandBlocked('').blocked).toBe(false);
    });

    it('纯空白命令不应被阻断', () => {
      expect(isExecCommandBlocked('   ').blocked).toBe(false);
    });

    it('阻断结果应包含原因', () => {
      const result = isExecCommandBlocked('diskpart');
      expect(result.blocked).toBe(true);
      expect(result.reason.length).toBeGreaterThan(0);
    });

    it('未阻断结果原因应为空', () => {
      const result = isExecCommandBlocked('git status');
      expect(result.blocked).toBe(false);
      expect(result.reason).toBe('');
    });
  });
});
