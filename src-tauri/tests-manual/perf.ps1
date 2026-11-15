# Mide memoria y CPU de JarWis (proceso + descendientes msedgewebview2) con la isla visible y oculta.
#   perf.ps1 [-Seconds 30] [-Settle 10]
# Solo imprime cifras: nunca lee ni muestra CommandLine, rutas ni títulos. Requiere JarWis en marcha.
param([int]$Seconds = 30, [int]$Settle = 10)
$win = Join-Path $PSScriptRoot "win.ps1"
$Title = "JarWis"
$limProc = 37.7; $limTree = 490
$cores = [Environment]::ProcessorCount

function Tree {
  $all = Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, WorkingSetSize, PrivatePageCount, KernelModeTime, UserModeTime
  $root = $all | Where-Object { $_.Name -eq "jarwis.exe" } | Select-Object -First 1
  if (-not $root) { return $null }
  $ids = @($root.ProcessId); $i = 0
  while ($i -lt $ids.Count) {  # anchura: hijos de cada pid ya recogido
    $cur = $ids[$i++]
    $all | Where-Object { $_.ParentProcessId -eq $cur -and $ids -notcontains $_.ProcessId } | ForEach-Object { $ids += $_.ProcessId }
  }
  [pscustomobject]@{ Root = $root; Procs = @($all | Where-Object { $ids -contains $_.ProcessId }) }
}
function Cpu($t) { ($t.Procs | Measure-Object -Property KernelModeTime, UserModeTime -Sum | Measure-Object -Property Sum -Sum).Sum }
function MB($b) { [math]::Round($b / 1MB, 1) }

function Measure-State([string]$label) {
  $a = Tree; if (-not $a) { throw "JarWis dejo de estar en ejecucion" }
  Start-Sleep -Seconds $Seconds
  $b = Tree; if (-not $b) { throw "JarWis dejo de estar en ejecucion" }
  $pct = (Cpu $b) - (Cpu $a)
  $cpu1 = [math]::Round($pct / ($Seconds * 1e7) * 100, 2)
  [pscustomobject]@{
    Estado = $label; Procs = $b.Procs.Count
    ProcWS = MB $b.Root.WorkingSetSize; ProcPriv = MB $b.Root.PrivatePageCount
    TreeWS = MB ($b.Procs | Measure-Object WorkingSetSize -Sum).Sum
    TreePriv = MB ($b.Procs | Measure-Object PrivatePageCount -Sum).Sum
    Cpu1 = $cpu1; CpuAll = [math]::Round($cpu1 / $cores, 2)
  }
}
function Visible { (& $win visible $Title) -eq $true }

if (-not (Get-Process jarwis -ErrorAction SilentlyContinue)) { Write-Error "JarWis no esta en ejecucion"; exit 1 }
$orig = Visible
if (-not $orig) { & $win tray-left; Start-Sleep -Seconds 2; if (-not (Visible)) { Write-Error "no se pudo mostrar la isla"; exit 1 } }
$vis = Measure-State "visible"
& $win tray-left; Start-Sleep -Seconds 2
if (Visible) { Write-Error "la isla sigue visible tras tray-left"; exit 1 }
Start-Sleep -Seconds $Settle
$hid = Measure-State "oculta"
if ($orig) { & $win tray-left; Start-Sleep -Seconds 2 }
$restored = (Visible) -eq $orig

$fail = $false
foreach ($r in $vis, $hid) {
  $ok = ($r.ProcWS -le $limProc) -and ($r.TreeWS -le $limTree); if (-not $ok) { $fail = $true }
  "{0,-8} procs={1} | jarwis WS={2} MB priv={3} MB | arbol WS={4} MB priv={5} MB | CPU={6}% de un nucleo, {7}% del total ({8} nucleos) | {9}" -f `
    $r.Estado, $r.Procs, $r.ProcWS, $r.ProcPriv, $r.TreeWS, $r.TreePriv, $r.Cpu1, $r.CpuAll, $cores, $(if ($ok) { "PASS" } else { "FAIL" })
}
"limites: jarwis.exe WS <= $limProc MB, arbol WS <= $limTree MB"
"estado original restaurado (visible=$orig): $restored"
if ($fail -or -not $restored) { exit 1 }
