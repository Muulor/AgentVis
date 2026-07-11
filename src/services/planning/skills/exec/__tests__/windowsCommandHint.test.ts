/**
 * generateWindowsCommandHint — 单元测试
 */

import { describe, it, expect } from 'vitest';
import {
  collectExecObservationHints,
  generateCmdLabelHint,
  generateCmdSetPromptHint,
  generateCmdSingleQuoteOperatorHint,
  generateCmdVariableExpansionHint,
  generateExecTimeoutGuidance,
  extractLocalWebServerUrls,
  generateFileReadPathFailureHint,
  generateInlineEvalNewlineHint,
  generateLocalWebServerVerificationHint,
  generateMojibakeHint,
  generateRemCommandHint,
  generateShellOperatorHint,
  generateSilentNonZeroExitHint,
  generateUnicodeReplacementHint,
  generateWindowsCommandHint,
} from '../tool';

describe('generateWindowsCommandHint', () => {
  it('【真实 log 复现】head 命令应返回 Select-Object 提示', () => {
    const stderr =
      "'head' is not recognized as an internal or external command,\noperable program or batch file.";
    const hint = generateWindowsCommandHint(stderr, 'dir /B | head -1');
    expect(hint).toContain('head');
    expect(hint).toContain('Select-Object -First N');
  });

  it('grep 命令应返回 findstr 或 Select-String 提示', () => {
    const stderr =
      "'grep' is not recognized as an internal or external command,\noperable program or batch file.";
    const hint = generateWindowsCommandHint(stderr, 'grep "pattern" file.txt');
    expect(hint).toContain('findstr');
    expect(hint).toContain('Select-String');
  });

  it('未在映射表中的 Linux 命令应返回通用兜底提示', () => {
    const stderr =
      "'htop' is not recognized as an internal or external command,\noperable program or batch file.";
    const hint = generateWindowsCommandHint(stderr, 'htop');
    expect(hint).toContain('htop');
    expect(hint).toContain('Windows');
    expect(hint).toContain('PowerShell');
  });

  it('非 "not recognized" 的错误不应返回提示', () => {
    const stderr = 'File Not Found';
    const hint = generateWindowsCommandHint(stderr, 'dir nonexistent.txt');
    expect(hint).toBeNull();
  });

  it('空 stderr 不应返回提示', () => {
    expect(generateWindowsCommandHint('', 'dir')).toBeNull();
  });

  it('cat 命令应返回 type 提示', () => {
    const stderr =
      "'cat' is not recognized as an internal or external command,\noperable program or batch file.";
    const hint = generateWindowsCommandHint(stderr, 'cat file.txt');
    expect(hint).toContain('type');
  });

  it('which 命令应返回 where 提示', () => {
    const stderr =
      "'which' is not recognized as an internal or external command,\noperable program or batch file.";
    const hint = generateWindowsCommandHint(stderr, 'which python');
    expect(hint).toContain('where');
  });
});

describe('generateFileReadPathFailureHint', () => {
  it('type 读取特殊路径失败时应提示优先使用 read 或动态定位路径', () => {
    const command = 'type "C:\\Users\\Muulo\\output\\AI Whistleblower_ They’re Hiding.md"';
    const hint = generateFileReadPathFailureHint(
      command,
      'The system cannot find the file specified.'
    );
    expect(hint).toContain('read');
    expect(hint).toContain('Get-ChildItem');
  });

  it('PowerShell Get-Content 直接路径失败时应提示动态定位路径', () => {
    const command =
      "powershell -NoProfile -Command \"Get-Content -LiteralPath 'C:\\Users\\Muulo\\output\\They''re.md'\"";
    const hint = generateFileReadPathFailureHint(
      command,
      'Get-Content : An object at the specified path does not exist, or has been filtered by the -Include or -Exclude parameter.'
    );
    expect(hint).toContain('Get-ChildItem');
  });

  it('非文件读取命令失败时不应返回提示', () => {
    expect(
      generateFileReadPathFailureHint('npm test', 'The system cannot find the file specified.')
    ).toBeNull();
  });
});

describe('generateMojibakeHint', () => {
  it('Get-Content 输出疑似 mojibake 时应提示 UTF-8 读取', () => {
    const command =
      'powershell -NoProfile -Command "Get-ChildItem -Filter \'*.md\' | Get-Content -TotalCount 5"';
    const hint = generateMojibakeHint(command, 'They鈥檙e Hiding The Truth!');
    expect(hint).toContain('UTF-8');
  });

  it('普通输出不应返回编码提示', () => {
    const command = 'powershell -NoProfile -Command "Get-Content file.txt"';
    expect(generateMojibakeHint(command, 'normal output')).toBeNull();
  });
});

describe('generateExecTimeoutGuidance', () => {
  it('cargo test 超时时应提示先缩小测试并区分编译与运行卡住', () => {
    const hint = generateExecTimeoutGuidance(
      'cargo test -p daw-engine -- mixer',
      'Command execution timed out after 300 seconds'
    );

    expect(hint).toContain('cargo test');
    expect(hint).toContain('-- --list');
    expect(hint).toContain('--exact --nocapture');
    expect(hint).toContain('--no-run');
  });

  it('非 cargo test 超时时应返回通用 timeout 排查提示', () => {
    const hint = generateExecTimeoutGuidance('npm test', 'execution timed out');

    expect(hint).toContain('timeout');
    expect(hint).toContain('详细输出');
    expect(hint).not.toContain('-- --list');
  });

  it('非超时输出不应返回提示', () => {
    expect(generateExecTimeoutGuidance('cargo test', 'test failed')).toBeNull();
  });
});

describe('exec observation quality hints', () => {
  it('inline eval 代码参数包含真实换行时应提示改用分号或脚本', () => {
    const command = "python -c \"print('a')\nprint('b')\"";
    const hint = generateInlineEvalNewlineHint(command);

    expect(hint).toContain('[EXEC_CMD_HINT]');
    expect(hint).toContain('python -c/node -e');
  });

  it('inline eval 使用分号分隔时不应提示真实换行', () => {
    const command = "python -c \"print('a'); print('b')\"";
    expect(generateInlineEvalNewlineHint(command)).toBeNull();
  });

  it('cmd 同行 set 后读取百分号变量时应提示 parse-time expansion', () => {
    const hint = generateCmdVariableExpansionHint('set TESTVAR=ok & echo %TESTVAR%');

    expect(hint).toContain('[EXEC_CMD_HINT]');
    expect(hint).toContain('%VAR%');
  });

  it('cmd set 的引号安全写法同样应提示 parse-time expansion', () => {
    const hint = generateCmdVariableExpansionHint('set "TESTVAR=ok" & echo %TESTVAR%');

    expect(hint).toContain('[EXEC_CMD_HINT]');
    expect(hint).toContain('%VAR%');
  });

  it('cmd 同行 set 后读取变量替换表达式时应提示 parse-time expansion', () => {
    const hint = generateCmdVariableExpansionHint('set "VAR=HelloWorld" & echo %VAR:Hello=Hi%');

    expect(hint).toContain('[EXEC_CMD_HINT]');
    expect(hint).toContain('%VAR%');
  });

  it('cmd 同行 set 后通过 call 读取变量切片时应提示 parse-time expansion', () => {
    const hint = generateCmdVariableExpansionHint('set "VAR=ABCDEF" & call echo %%VAR:~0,3%%');

    expect(hint).toContain('[EXEC_CMD_HINT]');
    expect(hint).toContain('%VAR%');
  });

  it('cmd 同行 set /a 后读取百分号变量时应提示 parse-time expansion', () => {
    const hint = generateCmdVariableExpansionHint('set /a "result=10%%3" & echo %result%');

    expect(hint).toContain('[EXEC_CMD_HINT]');
    expect(hint).toContain('%VAR%');
  });

  it('cmd 同行 setlocal delayed expansion 时应提示 /V:ON 或脚本', () => {
    const hint = generateCmdVariableExpansionHint(
      'setlocal enabledelayedexpansion & set X=ok & echo !X!'
    );

    expect(hint).toContain('[EXEC_CMD_HINT]');
    expect(hint).toContain('!VAR!');
  });

  it('管道后的字面文本被当成命令时应提示转义 shell 运算符', () => {
    const stderr = "'char' 不是内部或外部命令，也不是可运行的程序或批处理文件。";
    const hint = generateShellOperatorHint('echo pipe | char', stderr);

    expect(hint).toContain('[EXEC_CMD_HINT]');
    expect(hint).toContain('char');
    expect(hint).toContain('^|');
  });

  it('裸 & 分隔符导致单引号字面量被拆开时应提示 shell 运算符', () => {
    const stderr = "'b'' 不是内部或外部命令，也不是可运行的程序或批处理文件。";
    const hint = generateShellOperatorHint("echo 'a & b'", stderr);

    expect(hint).toContain('[EXEC_CMD_HINT]');
    expect(hint).toContain('b');
    expect(hint).toContain('^&');
  });

  it('echo 单引号内裸 || 时应提示 cmd 不识别单引号分组', () => {
    const hint = generateCmdSingleQuoteOperatorHint("echo 'a || b'");

    expect(hint).toContain('[EXEC_CMD_HINT]');
    expect(hint).toContain('单引号');
    expect(hint).toContain('||');
  });

  it('echo 单引号内已转义的运算符不应触发单引号提示', () => {
    expect(generateCmdSingleQuoteOperatorHint("echo 'a ^& b'")).toBeNull();
  });

  it('for /f 命令替换语法中的单引号运算符不应触发 echo 单引号提示', () => {
    expect(
      generateCmdSingleQuoteOperatorHint("for /f %i in ('echo a ^& echo b') do echo %i")
    ).toBeNull();
  });

  it('正常条件执行链不应触发单引号提示', () => {
    expect(generateCmdSingleQuoteOperatorHint('echo a && echo b || echo c')).toBeNull();
  });

  it('rem 后包含命令连接符时应提示整行可能被注释吞掉', () => {
    const hint = generateRemCommandHint('rem comment & echo actual');

    expect(hint).toContain('[EXEC_CMD_HINT]');
    expect(hint).toContain('rem');
  });

  it('普通 rem 注释不应触发注释吞命令提示', () => {
    expect(generateRemCommandHint('rem just a comment')).toBeNull();
  });

  it('直接命令行使用 :: 标签语法并出现驱动器错误时应提示其不是通用注释命令', () => {
    const hint = generateCmdLabelHint(':: comment & echo test', '系统找不到指定的驱动器。');

    expect(hint).toContain('[EXEC_CMD_HINT]');
    expect(hint).toContain('::');
    expect(hint).toContain('rem');
  });

  it(':: 没有对应驱动器错误时不应触发标签提示', () => {
    expect(generateCmdLabelHint('echo :: literal', '')).toBeNull();
  });

  it('set /p 在非交互 stdin 下非零退出时应提示 EOF 限制', () => {
    const hint = generateCmdSetPromptHint('set /p "X=Prompt:"', 1, '');

    expect(hint).toContain('[EXEC_CMD_HINT]');
    expect(hint).toContain('set /p');
    expect(hint).toContain('stdin');
  });

  it('set /p 成功或已有 stderr 时不应额外提示非交互 EOF', () => {
    expect(generateCmdSetPromptHint('set /p "X=Prompt:"', 0, '')).toBeNull();
    expect(generateCmdSetPromptHint('set /p "X=Prompt:"', 1, 'syntax error')).toBeNull();
  });

  it('管道后的高频 Linux 命令仍交给 Windows 命令提示处理', () => {
    const stderr = "'head' is not recognized as an internal or external command";
    expect(generateShellOperatorHint('dir /B | head -1', stderr)).toBeNull();
  });

  it('cmd echo 非 ASCII 文本输出问号时应提示 Unicode 代码页限制', () => {
    const hint = generateUnicodeReplacementHint('echo 中文 한국어', '中文 ???');

    expect(hint).toContain('[EXEC_CMD_HINT]');
    expect(hint).toContain('Unicode');
  });

  it('findstr 非 0 退出且 stderr 为空时应提示检查 exitCode 与语法', () => {
    const hint = generateSilentNonZeroExitHint('findstr "unmatched', 1, '', '');

    expect(hint).toContain('[EXEC_CMD_HINT]');
    expect(hint).toContain('findstr');
  });

  it('显式退出码不应额外提示 exec 静默失败', () => {
    const command = 'python -c "import sys; sys.exit(3)"';
    expect(generateSilentNonZeroExitHint(command, 3, '', '')).toBeNull();
  });

  it('extractLocalWebServerUrls detects local service URLs and strips sensitive query/hash parts', () => {
    const urls = extractLocalWebServerUrls(
      'Local: http://localhost:5173/?token=secret\nNetwork: http://0.0.0.0:3000/app#debug'
    );

    expect(urls).toEqual(['http://localhost:5173/', 'http://localhost:3000/app']);
  });

  it('generateLocalWebServerVerificationHint suggests agent-browser verification and CDP cleanup', () => {
    const hint = generateLocalWebServerVerificationHint('VITE ready at http://127.0.0.1:5173/', '');

    expect(hint).toContain('[EXEC_BROWSER_VERIFICATION_HINT]');
    expect(hint).toContain('http://127.0.0.1:5173/');
    expect(hint).toContain('agent-browser');
    expect(hint).toContain('CDP');
  });

  it('collectExecObservationHints 应汇总成功命令中的高风险可误解现象', () => {
    const hints = collectExecObservationHints(
      "node -e \"console.log('a')\nconsole.log('b')\"",
      0,
      'a\n',
      ''
    );

    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('inline eval');
  });
});
