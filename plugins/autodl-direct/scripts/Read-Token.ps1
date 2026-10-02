# Internal helper. The MCP process captures this output; do not invoke it in chat.
param([Parameter(Mandatory=$true)][string]$CredentialFile)
$ErrorActionPreference = 'Stop'
try {
    $taskSecureToken = (Get-Content -LiteralPath $CredentialFile -Raw).Trim() | ConvertTo-SecureString
    $taskSecretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecureToken)
    try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskSecretPointer).Trim()) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskSecretPointer) }
} catch { [Console]::Error.Write('Unable to decrypt AutoDL credential.'); exit 1 }
