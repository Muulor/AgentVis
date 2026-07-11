/**
 * normalizeWindowsQuotes 引号修正 — 单元测试
 *
 * 覆盖场景：
 * 1. PowerShell -Command 外层单引号 → 双引号修正
 * 2. 已用双引号的 PowerShell 命令不干预
 * 3. 无 -Command 参数的 PowerShell 命令不干预
 * 4. cmd.exe 上下文的路径/URL 单引号替换
 * 5. 来自真实 log 的失败命令重现
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeWindowsQuotes,
  normalizePowerShellCommandQuotes,
  normalizeSmartQuotes,
  normalizeSmartQuotesForWindowsCommand,
  normalizeInlineEvalCommandQuotes,
  normalizeWindowsCommandLineBreaks,
} from '../tool';

describe('normalizeSmartQuotes', () => {
  it('应将弯引号规范化为 ASCII 引号', () => {
    const input = 'python -c “target=’http://127.0.0.1’; print(target.rstrip(’=’))”';
    const expected = "python -c \"target='http://127.0.0.1'; print(target.rstrip('='))\"";
    expect(normalizeSmartQuotes(input)).toBe(expected);
  });
});

describe('normalizeSmartQuotesForWindowsCommand', () => {
  it('应保留双引号路径内的 Unicode 右单引号文件名字符', () => {
    const input = 'type "C:\\Users\\Admin\\output\\AI Whistleblower_ They’re Hiding.md"';
    expect(normalizeSmartQuotesForWindowsCommand(input)).toBe(input);
  });

  it('仍应修正命令参数边界使用的智能单引号', () => {
    const input = 'dir ‘C:\\Users\\Admin\\Desktop’';
    expect(normalizeSmartQuotesForWindowsCommand(input)).toBe("dir 'C:\\Users\\Admin\\Desktop'");
  });
});

describe('normalizePowerShellCommandQuotes', () => {
  it('应将 -Command 外层单引号替换为双引号', () => {
    const input = "powershell -Command 'Get-ChildItem -Path C:\\Users'";
    const expected = 'powershell -Command "Get-ChildItem -Path C:\\Users"';
    expect(normalizePowerShellCommandQuotes(input)).toBe(expected);
  });

  it('应保留内部 PowerShell 单引号不变', () => {
    const input = "powershell -Command 'Get-ChildItem -Path 'C:\\Program Files' -Recurse'";
    const expected = 'powershell -Command "Get-ChildItem -Path \'C:\\Program Files\' -Recurse"';
    expect(normalizePowerShellCommandQuotes(input)).toBe(expected);
  });

  it('应支持 pwsh 前缀', () => {
    const input = "pwsh -Command 'Get-Process'";
    const expected = 'pwsh -Command "Get-Process"';
    expect(normalizePowerShellCommandQuotes(input)).toBe(expected);
  });

  it('应支持 powershell.exe 前缀', () => {
    const input = "powershell.exe -Command 'Get-Process'";
    const expected = 'powershell.exe -Command "Get-Process"';
    expect(normalizePowerShellCommandQuotes(input)).toBe(expected);
  });

  it('应支持 -Command 前有其他 flags', () => {
    const input = "powershell -NoProfile -Command 'Get-ChildItem'";
    const expected = 'powershell -NoProfile -Command "Get-ChildItem"';
    expect(normalizePowerShellCommandQuotes(input)).toBe(expected);
  });

  it('已用双引号的 -Command 不应修改', () => {
    const input = 'powershell -Command "Get-ChildItem"';
    expect(normalizePowerShellCommandQuotes(input)).toBe(input);
  });

  it('无 -Command 参数时不应修改', () => {
    const input = "powershell -File 'script.ps1'";
    expect(normalizePowerShellCommandQuotes(input)).toBe(input);
  });

  it('内部包含双引号时应保持原样（安全阀）', () => {
    const input = `powershell -Command 'echo "hello"'`;
    expect(normalizePowerShellCommandQuotes(input)).toBe(input);
  });

  it('无引号包裹 -Command 参数值时不应修改', () => {
    const input = 'powershell -Command Get-Process';
    expect(normalizePowerShellCommandQuotes(input)).toBe(input);
  });
});

describe('normalizeWindowsQuotes — PowerShell 场景', () => {
  it('【真实 log 复现】应修正 Get-ChildItem 桌面搜索命令', () => {
    // 来自 desktop-control 执行 log Step 4 的失败命令
    const input =
      "powershell -Command 'Get-ChildItem -Path $env:USERPROFILE\\Desktop | Where-Object { $_.Name -like '*网易云*' }'";
    const result = normalizeWindowsQuotes(input);

    // 外层单引号应被替换为双引号
    expect(result).toContain('powershell -Command "Get-ChildItem');
    // 内部 PowerShell 单引号应保留
    expect(result).toContain("'*网易云*'");
    // 末尾应以双引号结束
    expect(result).toMatch(/"$/);
  });

  it('【真实 log 复现】应修正 Program Files 递归搜索命令', () => {
    // 来自 desktop-control 执行 log Step 8 的失败命令
    const input =
      "powershell -Command 'Get-ChildItem -Path 'C:\\Program Files', 'C:\\Program Files (x86)' -Recurse -Filter '*cloudmusic*.exe' -ErrorAction SilentlyContinue'";
    const result = normalizeWindowsQuotes(input);

    expect(result).toContain('powershell -Command "Get-ChildItem');
    expect(result).toContain("'C:\\Program Files'");
    expect(result).toMatch(/"$/);
  });

  it('已正确使用双引号的 PowerShell 命令不应修改', () => {
    const input = 'powershell -Command "Get-ChildItem \'C:\\Program Files\'"';
    expect(normalizeWindowsQuotes(input)).toBe(input);
  });
});

describe('normalizeWindowsQuotes — cmd.exe 场景', () => {
  it('应将路径单引号替换为双引号', () => {
    const input = "dir 'C:\\Users\\Admin\\Desktop'";
    const expected = 'dir "C:\\Users\\Admin\\Desktop"';
    expect(normalizeWindowsQuotes(input)).toBe(expected);
  });

  it('路径以 \\\\ 结尾时应追加 \\\\', () => {
    const input = "cd 'C:\\'";
    const expected = 'cd "C:\\\\"';
    expect(normalizeWindowsQuotes(input)).toBe(expected);
  });

  it('echo 字面文本单引号应保持原样', () => {
    const input = "echo 'hello world'";
    const expected = "echo 'hello world'";
    expect(normalizeWindowsQuotes(input)).toBe(expected);
  });

  it('【真实 log 复现】findstr 搜索模式的单引号应替换为双引号', () => {
    const input = "findstr /n 'mixer\\|channel\\|vu-meter' 'C:\\Users\\Admin\\main.css'";
    const result = normalizeWindowsQuotes(input);
    // 搜索模式和路径的单引号都应被替换
    expect(result).toContain('"mixer\\|channel\\|vu-meter"');
    expect(result).toContain('"C:\\Users\\Admin\\main.css"');
    expect(result).not.toContain("'");
  });

  it('多组单引号参数应全部替换', () => {
    const input = "findstr 'pattern1' 'pattern2' 'file.txt'";
    const result = normalizeWindowsQuotes(input);
    expect(result).toBe('findstr "pattern1" "pattern2" "file.txt"');
  });

  it('应修正双引号外的弯单引号参数', () => {
    const input = 'dir ‘C:\\Users\\Admin\\Desktop’';
    const result = normalizeWindowsQuotes(input);
    expect(result).toBe('dir "C:\\Users\\Admin\\Desktop"');
  });

  it('不应把双引号路径内的 U+2019 文件名字符改成 ASCII 撇号', () => {
    const input = 'type "C:\\Users\\Admin\\output\\AI Whistleblower_ They’re Hiding.md"';
    expect(normalizeWindowsQuotes(input)).toBe(input);
  });

  it('不应替换 node -e 双引号代码内部的单引号字符串', () => {
    const input = 'node -e “const net = require(’net’); console.log(’connected’);”';
    const result = normalizeWindowsQuotes(input);
    expect(result).toBe("node -e \"const net = require('net'); console.log('connected');\"");
  });

  it('不应替换 python -c 双引号代码内部的单引号字符串', () => {
    const input = 'python -c “import base64; target=‘http://127.0.0.1’; print(target.rstrip(‘=’))”';
    const result = normalizeWindowsQuotes(input);
    expect(result).toBe(
      "python -c \"import base64; target='http://127.0.0.1'; print(target.rstrip('='))\""
    );
  });

  it('不应把含内层双引号的 echo 单引号片段改写成嵌套双引号', () => {
    const input = 'echo \'He said "hello"\'';
    expect(normalizeWindowsQuotes(input)).toBe(input);
  });

  it('不应改写 echo 命令中普通单引号字面量', () => {
    const input = 'echo mixed "double" and \'single\' quotes';
    expect(normalizeWindowsQuotes(input)).toBe(input);
  });

  it('不应改写 for /f 命令替换语法中的单引号', () => {
    const input = "for /f %i in ('echo nestedcmd') do echo %i";
    expect(normalizeWindowsQuotes(input)).toBe(input);
  });

  it('不应改写带选项的 for /f 命令替换语法中的单引号', () => {
    const input = 'for /f "delims=" %%i in (\'dir /b\') do echo %%i';
    expect(normalizeWindowsQuotes(input)).toBe(input);
  });

  it('应修正单引号包裹的 python -c 代码参数', () => {
    const input = "python -c 'import os; print(os.getcwd())'";
    expect(normalizeWindowsQuotes(input)).toBe('python -c "import os; print(os.getcwd())"');
  });

  it('应转义单引号 inline eval 代码中的内层双引号', () => {
    const input = 'node -e \'console.log("hello from node")\'';
    expect(normalizeWindowsQuotes(input)).toBe('node -e "console.log(\\"hello from node\\")"');
  });

  it('不应破坏管道后 python -c 中的 JSON 字段单引号', () => {
    const input =
      'curl -s https://api.github.com/repos/openai/openai-python | python -c “import sys,json; d=json.load(sys.stdin); print(’stars:’, d.get(’stargazers_count’, ’N/A’))”';
    const result = normalizeWindowsQuotes(input);
    expect(result).toBe(
      "curl -s https://api.github.com/repos/openai/openai-python | python -c \"import sys,json; d=json.load(sys.stdin); print('stars:', d.get('stargazers_count', 'N/A'))\""
    );
  });

  it('空命令应返回原样', () => {
    expect(normalizeWindowsQuotes('')).toBe('');
  });
});

describe('normalizeInlineEvalCommandQuotes', () => {
  it('不应再翻倍 node -e 的代码参数外层双引号', () => {
    const input = "node -e \"const net = require('net'); console.log('connected');\"";
    const result = normalizeInlineEvalCommandQuotes(input);
    expect(result).toBe(input);
  });

  it('不应再翻倍 python -c 的代码参数外层双引号', () => {
    const input = 'python -c "import base64; target=\'http://127.0.0.1\'; print(target)"';
    const result = normalizeInlineEvalCommandQuotes(input);
    expect(result).toBe(input);
  });

  it('应保持含空格 import 语句的 python -c 命令原样', () => {
    const input = 'python -c "import os; print(os.getcwd())"';
    expect(normalizeInlineEvalCommandQuotes(input)).toBe(input);
  });

  it('应保持分号后带空格的 node -e 命令原样', () => {
    const input = "node -e \"console.log('a'); console.log('b')\"";
    expect(normalizeInlineEvalCommandQuotes(input)).toBe(input);
  });

  it('不应修改普通脚本路径和带空格参数', () => {
    const input =
      'python "C:/Users/Muulo/AppData/Roaming/com.agentvis.app/skills/external/packages/arxiv-search/scripts/arxiv_search.py" search "LLM agent" --limit 15 --sort date';
    expect(normalizeInlineEvalCommandQuotes(input)).toBe(input);
  });

  it('应支持管道后的 python -c', () => {
    const input = 'curl -s https://example.com | python -c "import sys; print(sys.stdin.read())"';
    const result = normalizeInlineEvalCommandQuotes(input);
    expect(result).toBe(input);
  });
});

describe('normalizeWindowsCommandLineBreaks', () => {
  it('应将双引号外的多行命令转换为 cmd.exe 可执行的 & 分隔', () => {
    const input = 'echo line1\necho line2\r\necho line3';
    expect(normalizeWindowsCommandLineBreaks(input)).toBe('echo line1 & echo line2 & echo line3');
  });

  it('应保留 inline eval 双引号代码参数内部的换行', () => {
    const input = "python -c \"print('a')\nprint('b')\"";
    expect(normalizeWindowsCommandLineBreaks(input)).toBe(input);
  });

  it('应识别 inline eval 中反斜杠转义的内层双引号', () => {
    const input = 'node -e "console.log(\\"a\\")\nconsole.log(\\"b\\")"';
    expect(normalizeWindowsCommandLineBreaks(input)).toBe(input);
  });

  it('不应在已显式续接的行尾追加额外分隔符', () => {
    const input = 'echo line1 &&\necho line2';
    expect(normalizeWindowsCommandLineBreaks(input)).toBe('echo line1 &&echo line2');
  });

  it('应保留 cmd 行尾 caret 续行语义', () => {
    const input = 'echo hello ^\nworld';
    expect(normalizeWindowsCommandLineBreaks(input)).toBe('echo hello world');
  });

  it('偶数个行尾 caret 不应被当作续行符', () => {
    const input = 'echo caret ^^\necho next';
    expect(normalizeWindowsCommandLineBreaks(input)).toBe('echo caret ^^ & echo next');
  });
});
