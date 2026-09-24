$ErrorActionPreference = 'Stop'
$path = $env:KIT_PRIVATE_ACL_PATH
$kind = $env:KIT_PRIVATE_ACL_KIND
$repair = $env:KIT_PRIVATE_ACL_REPAIR -eq '1'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if ($repair) {
  if ($kind -eq 'dir') {
    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  } else {
    $acl = [System.Security.AccessControl.FileSecurity]::new()
  }
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($sid)
  if ($kind -eq 'dir') {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit),
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
  } else {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
  }
  [void]$acl.AddAccessRule($rule)
  if ($kind -eq 'dir') {
    [System.IO.Directory]::SetAccessControl($path, $acl)
  } else {
    [System.IO.File]::SetAccessControl($path, $acl)
  }
}
if ($kind -eq 'dir') {
  $acl = [System.IO.Directory]::GetAccessControl($path)
} else {
  $acl = [System.IO.File]::GetAccessControl($path)
}
$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
$entries = @($acl.Access)
$valid = $acl.AreAccessRulesProtected -and $owner -eq $sid.Value -and $entries.Count -eq 1
if ($valid) {
  $entry = $entries[0]
  $entrySid = $entry.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
  $full = [System.Security.AccessControl.FileSystemRights]::FullControl
  $valid = -not $entry.IsInherited -and
    $entrySid -eq $sid.Value -and
    $entry.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
    (($entry.FileSystemRights -band $full) -eq $full)
}
if (-not $valid) { exit 3 }
Write-Output 'PRIVATE'
