param([Parameter(Mandatory = $true)][string]$CertificateDirectory)
$ErrorActionPreference = 'Stop'
$userSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$directory = Get-Item -LiteralPath $CertificateDirectory -Force
if (-not $directory.PSIsContainer -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Certificate storage must be a regular directory.'
}
$items = @($directory) + @(Get-ChildItem -LiteralPath $directory.FullName -Force)
foreach ($item in $items) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or ($item.PSIsContainer -and $item.FullName -ne $directory.FullName)) {
        throw 'Unexpected link or subdirectory in certificate storage.'
    }
    if ($item.PSIsContainer) {
        $acl = [System.Security.AccessControl.DirectorySecurity]::new()
        $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    } else {
        $acl = [System.Security.AccessControl.FileSecurity]::new()
        $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
    }
    $acl.SetOwner($userSid)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($userSid, $systemSid)) {
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
            $sid, [System.Security.AccessControl.FileSystemRights]::FullControl,
            $inheritance, [System.Security.AccessControl.PropagationFlags]::None,
            [System.Security.AccessControl.AccessControlType]::Allow)
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $item.FullName -AclObject $acl
    $verified = Get-Acl -LiteralPath $item.FullName
    $rules = @($verified.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    if (-not $verified.AreAccessRulesProtected -or $rules.Count -ne 2 -or
        $verified.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $userSid.Value) {
        throw 'Certificate permissions could not be verified.'
    }
    foreach ($rule in $rules) {
        if ($rule.IdentityReference.Value -notin @($userSid.Value, $systemSid.Value) -or
            $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl') {
            throw 'Unexpected access to certificate storage.'
        }
    }
}
