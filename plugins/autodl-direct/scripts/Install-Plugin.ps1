# Installs from the repository catalog after checking its exact local source.
$ErrorActionPreference = 'Stop'
$taskPluginRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$taskRepositoryRoot = Split-Path -Parent (Split-Path -Parent $taskPluginRoot)
$taskCatalogFile = Join-Path $taskRepositoryRoot '.agents\plugins\marketplace.json'
if (-not (Test-Path -LiteralPath $taskCatalogFile -PathType Leaf)) {
    throw '请从完整的 autodl-direct Git 仓库运行安装脚本；缺少仓库目录清单。'
}
$taskCatalog = Get-Content -LiteralPath $taskCatalogFile -Raw | ConvertFrom-Json
$taskEntries = @($taskCatalog.plugins | Where-Object { $_.name -eq 'autodl-direct' })
if ($taskCatalog.name -ne 'autodl-tools' -or $taskEntries.Count -ne 1 -or
    $taskEntries[0].source.source -ne 'local' -or -not $taskEntries[0].source.path -or
    -not $taskEntries[0].source.path.StartsWith('./')) {
    throw '仓库目录清单与 AutoDL Direct 不匹配。'
}
$taskResolvedSource = [IO.Path]::GetFullPath((Join-Path $taskRepositoryRoot $taskEntries[0].source.path))
if ($taskResolvedSource -ne $taskPluginRoot) {
    throw '仓库目录清单未指向此插件源码。'
}
& codex plugin marketplace add $taskRepositoryRoot
if ($LASTEXITCODE -ne 0) { throw '本地插件目录注册失败。' }
& codex plugin add ('autodl-direct@' + $taskCatalog.name)
if ($LASTEXITCODE -ne 0) { throw '插件安装失败。' }
Write-Output 'AutoDL Direct 已安装。请在新聊天中使用它，或重启插件连接。'
