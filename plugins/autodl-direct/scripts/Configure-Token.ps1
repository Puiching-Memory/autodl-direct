param([string]$CredentialFile)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw '此凭据配置脚本使用 Windows DPAPI，仅支持 Windows。' }
if (-not $CredentialFile) { $CredentialFile = Join-Path $env:LOCALAPPDATA 'CodexAutoDL\token.dpapi' }
$taskSecret = Read-Host '请输入 AutoDL 开发者 Token（输入隐藏）' -AsSecureString
$taskSecretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecret)
try {
    $taskPlainToken = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskSecretPointer).Trim()
    if (-not $taskPlainToken) { throw 'Token 不能为空。' }
    try {
        $taskVerification = Invoke-RestMethod -Method Post -Uri 'https://api.autodl.com/api/v1/dev/wallet/balance' -Headers @{Authorization=$taskPlainToken} -TimeoutSec 20 -MaximumRedirection 0
    } catch { throw 'AutoDL Token 验证未完成。请检查网络、实名认证或 Token，不会保存未验证的凭据。' }
    if ($taskVerification.code -ne 'Success') { throw 'AutoDL 拒绝了此凭据。请检查实名认证与 Token。' }
    $taskCredentialDirectory = Split-Path -Parent ([IO.Path]::GetFullPath($CredentialFile))
    $null = New-Item -ItemType Directory -Path $taskCredentialDirectory -Force
    $taskEncryptedToken = $taskSecret | ConvertFrom-SecureString
    [IO.File]::WriteAllText([IO.Path]::GetFullPath($CredentialFile), $taskEncryptedToken, [Text.UTF8Encoding]::new($false))
    Write-Output 'AutoDL 凭据已通过只读验证，并使用当前 Windows 用户的 DPAPI 加密保存。'
} finally {
    $taskPlainToken = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskSecretPointer)
}
