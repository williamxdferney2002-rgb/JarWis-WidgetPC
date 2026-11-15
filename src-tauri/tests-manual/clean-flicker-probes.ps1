# Measurement lifecycle cleanup only. Run from the repo after all probes exit.
# Written for JW-34-6I; execution by Codex was rejected by automatic policy review.
$ErrorActionPreference='Stop'
$workspace='C:\dev\JarWis'
$targets=@(
  'C:\dev\JarWis\src-tauri\tests-manual\.jw-34-6i-runtime',
  'C:\dev\JarWis\src-tauri\tests-manual\JW-34-6I-runtime'
)
if ((Resolve-Path -LiteralPath '.').Path -cne $workspace) { throw 'Run from C:\dev\JarWis' }
$probes=@(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -in @('jw-flicker-fixture.exe','jarwis-observed.exe') -or
  ($_.Name -in @('jarwis.exe','msedgewebview2.exe') -and
   ($_.ExecutablePath -like "$workspace\src-tauri\tests-manual\*" -or
    $_.CommandLine -like '*tests-manual*.jw-34-6i-runtime*'))
})
if ($probes.Count) { throw 'Close the instrumented probe processes first' }
foreach ($target in $targets) {
  if (-not (Test-Path -LiteralPath $target)) { continue }
  $item=Get-Item -LiteralPath $target -Force
  $resolved=(Resolve-Path -LiteralPath $target).Path
  if ($resolved -cne $target -or -not $resolved.StartsWith($workspace+'\') -or
      ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Unsafe cleanup target: $resolved"
  }
  Write-Output "Verified cleanup target: $resolved"
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
