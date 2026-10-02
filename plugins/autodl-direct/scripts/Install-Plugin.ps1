# Registers the catalog that points to this exact source, then installs it.
$ErrorActionPreference = 'Stop'
$taskPluginRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$taskPluginParent = Split-Path -Parent $taskPluginRoot
$taskCatalogCandidates = @($taskPluginRoot, $taskPluginParent, (Split-Path -Parent $taskPluginParent))
$taskMarketplaceRoot = $null
$taskCatalogName = $null
foreach ($taskCandidate in $taskCatalogCandidates) {
    $taskCatalogFile = Join-Path $taskCandidate '.agents\plugins\marketplace.json'
    if (-not (Test-Path -LiteralPath $taskCatalogFile)) { continue }
    $taskCatalog = Get-Content -LiteralPath $taskCatalogFile -Raw | ConvertFrom-Json
    foreach ($taskEntry in $taskCatalog.plugins) {
        if ($taskEntry.name -ne 'autodl-direct') { continue }
        $taskSourcePath = if ($taskEntry.source -is [string]) { $taskEntry.source } else { $taskEntry.source.path }
        if (-not $taskSourcePath -or -not $taskSourcePath.StartsWith('./')) { continue }
        $taskResolvedSource = [IO.Path]::GetFullPath((Join-Path $taskCandidate $taskSourcePath))
        if ($taskResolvedSource -eq $taskPluginRoot) {
            $taskMarketplaceRoot = $taskCandidate
            $taskCatalogName = $taskCatalog.name
            break
        }
    }
    if ($taskMarketplaceRoot) { break }
}
if (-not $taskMarketplaceRoot) {
    $taskMarketplaceRoot = $taskPluginParent
    $taskMarketplaceFile = Join-Path $taskMarketplaceRoot '.agents\plugins\marketplace.json'
    if (Test-Path -LiteralPath $taskMarketplaceFile) {
        throw '父目录已有其他插件目录配置。请在独立目录解压，或从包含本插件的仓库根目录注册。'
    }
    $null = New-Item -ItemType Directory -Path (Split-Path -Parent $taskMarketplaceFile) -Force
    $taskCatalogName = 'autodl-tools'
    $taskCatalog = @{
        name=$taskCatalogName
        interface=@{displayName='AutoDL Direct'}
        plugins=@(@{
            name='autodl-direct'
            source=@{source='local';path=('./' + (Split-Path -Leaf $taskPluginRoot))}
            policy=@{installation='AVAILABLE';authentication='ON_USE'}
            category='Productivity'
        })
    }
    [IO.File]::WriteAllText($taskMarketplaceFile, ($taskCatalog | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
}
& codex plugin marketplace add $taskMarketplaceRoot
if ($LASTEXITCODE -ne 0) { throw '本地插件目录注册失败。' }
& codex plugin add ('autodl-direct@' + $taskCatalogName)
if ($LASTEXITCODE -ne 0) { throw '插件安装失败。' }
Write-Output 'AutoDL Direct 已安装。请在新聊天中使用它，或重启插件连接。'
