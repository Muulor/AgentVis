param(
    [switch]$ShowUnwrapAudit
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$targetRoots = @(
    "src-tauri/src/llm",
    "src-tauri/src/commands"
)

$fatalRules = @(
    @{
        Id = "utf8-len-min-slice"
        Pattern = '&\s*[A-Za-z_][A-Za-z0-9_.]*\s*\[\s*\.\.\s*[A-Za-z_][A-Za-z0-9_.]*\.len\(\)\.min\('
        Message = "Text preview slices must use crate::text_utils::safe_truncate."
    },
    @{
        Id = "utf8-preview-len-slice"
        Pattern = '&\s*[A-Za-z_][A-Za-z0-9_.]*\s*\[\s*\.\.\s*preview_len\s*\]'
        Message = "preview_len byte slices are unsafe for UTF-8 text; use safe_truncate."
    },
    @{
        Id = "utf8-max-text-slice"
        Pattern = '&\s*[A-Za-z_][A-Za-z0-9_.]*(raw|json|text|body|content|args|response)[A-Za-z0-9_.]*\s*\[\s*\.\.\s*MAX_[A-Z0-9_]*\s*\]'
        Message = "Max-length text slices must use safe_truncate to preserve UTF-8 boundaries."
    },
    @{
        Id = "mutex-lock-unwrap"
        Pattern = '\.lock\(\)\.unwrap\(\)'
        Message = "Mutex poisoning should be handled explicitly instead of panicking."
    }
)

$warningRules = @(
    @{
        Id = "chars-enumerate-index"
        Pattern = 'chars\(\)\.enumerate\(\)'
        Message = "If the index is later used to slice &str, use char_indices() instead."
    }
)

function Get-RelativePath([string]$Path) {
    $basePath = $repoRoot
    if (-not $basePath.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
        $basePath += [System.IO.Path]::DirectorySeparatorChar
    }
    $baseUri = New-Object System.Uri($basePath)
    $pathUri = New-Object System.Uri((Resolve-Path $Path).Path)
    return [System.Uri]::UnescapeDataString($baseUri.MakeRelativeUri($pathUri).ToString())
}

function Get-BraceDelta([string]$Line) {
    $open = ([regex]::Matches($Line, '\{')).Count
    $close = ([regex]::Matches($Line, '\}')).Count
    return $open - $close
}

$files = foreach ($root in $targetRoots) {
    $absoluteRoot = Join-Path $repoRoot $root
    if (Test-Path $absoluteRoot) {
        Get-ChildItem -Path $absoluteRoot -Recurse -Filter "*.rs" -File
    }
}

$fatalMatches = New-Object System.Collections.Generic.List[object]
$warningMatches = New-Object System.Collections.Generic.List[object]

foreach ($file in $files) {
    $lines = Get-Content -Path $file.FullName
    $pendingTestCfg = $false
    $inTestModule = $false
    $testModuleDepth = 0

    for ($index = 0; $index -lt $lines.Count; $index++) {
        $line = $lines[$index]

        if ($line -match '^\s*#\[cfg\(test\)\]') {
            $pendingTestCfg = $true
            continue
        }

        if ($pendingTestCfg -and $line -match '^\s*mod\s+tests\b') {
            $inTestModule = $true
            $pendingTestCfg = $false
            $testModuleDepth = Get-BraceDelta $line
            if ($testModuleDepth -le 0) {
                $inTestModule = $false
            }
            continue
        }

        if ($inTestModule) {
            $testModuleDepth += Get-BraceDelta $line
            if ($testModuleDepth -le 0) {
                $inTestModule = $false
            }
            continue
        }

        foreach ($rule in $fatalRules) {
            if ($line -match $rule.Pattern) {
                $fatalMatches.Add([pscustomobject]@{
                    Rule = $rule.Id
                    File = Get-RelativePath $file.FullName
                    Line = $index + 1
                    Text = $line.Trim()
                    Message = $rule.Message
                })
            }
        }
        foreach ($rule in $warningRules) {
            if ($line -match $rule.Pattern) {
                $warningMatches.Add([pscustomobject]@{
                    Rule = $rule.Id
                    File = Get-RelativePath $file.FullName
                    Line = $index + 1
                    Text = $line.Trim()
                    Message = $rule.Message
                })
            }
        }
    }
}

if ($fatalMatches.Count -gt 0) {
    Write-Host "Rust panic boundary check failed:" -ForegroundColor Red
    foreach ($match in $fatalMatches) {
        Write-Host ("[{0}] {1}:{2} {3}" -f $match.Rule, $match.File, $match.Line, $match.Message) -ForegroundColor Red
        Write-Host ("  {0}" -f $match.Text)
    }
    exit 1
}

Write-Host "Rust panic boundary check passed." -ForegroundColor Green

if ($warningMatches.Count -gt 0) {
    Write-Host "Warnings:" -ForegroundColor Yellow
    foreach ($match in $warningMatches) {
        Write-Host ("[{0}] {1}:{2} {3}" -f $match.Rule, $match.File, $match.Line, $match.Message) -ForegroundColor Yellow
        Write-Host ("  {0}" -f $match.Text)
    }
}

if ($ShowUnwrapAudit) {
    $unwrapMatches = New-Object System.Collections.Generic.List[object]
    foreach ($file in $files) {
        $lines = Get-Content -Path $file.FullName
        $pendingTestCfg = $false
        $inTestModule = $false
        $testModuleDepth = 0

        for ($index = 0; $index -lt $lines.Count; $index++) {
            $line = $lines[$index]

            if ($line -match '^\s*#\[cfg\(test\)\]') {
                $pendingTestCfg = $true
                continue
            }

            if ($pendingTestCfg -and $line -match '^\s*mod\s+tests\b') {
                $inTestModule = $true
                $pendingTestCfg = $false
                $testModuleDepth = Get-BraceDelta $line
                if ($testModuleDepth -le 0) {
                    $inTestModule = $false
                }
                continue
            }

            if ($inTestModule) {
                $testModuleDepth += Get-BraceDelta $line
                if ($testModuleDepth -le 0) {
                    $inTestModule = $false
                }
                continue
            }

            if ($line -match '\.(unwrap|expect)\(') {
                $unwrapMatches.Add([pscustomobject]@{
                    File = Get-RelativePath $file.FullName
                    Line = $index + 1
                    Text = $line.Trim()
                })
            }
        }
    }

    Write-Host ("unwrap/expect audit matches: {0}" -f $unwrapMatches.Count)
    foreach ($match in $unwrapMatches | Select-Object -First 50) {
        Write-Host ("  {0}:{1} {2}" -f $match.File, $match.Line, $match.Text)
    }
    if ($unwrapMatches.Count -gt 50) {
        Write-Host ("  ... {0} more" -f ($unwrapMatches.Count - 50))
    }
}
