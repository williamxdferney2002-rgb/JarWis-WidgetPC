# Builds only test instrumentation with the existing Windows SDK/MSVC. No downloads.
$ErrorActionPreference='Stop'
$root='C:\dev\JarWis'
$out=Join-Path $PSScriptRoot '.jw-34-6i-runtime'
if ((Resolve-Path $root).Path -ne (Get-Location).Path) { throw 'Run from C:\dev\JarWis' }
New-Item -ItemType Directory -Force $out | Out-Null
$env:TEMP=$out; $env:TMP=$out
$msvc='C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC\14.44.35207'
$sdk='C:\Program Files (x86)\Windows Kits\10'
$version='10.0.26100.0'
$inc=@('um','shared','ucrt','cppwinrt','winrt') | ForEach-Object { '/I'+(Join-Path $sdk "Include\$version\$_") }
$inc+='/I'+(Join-Path $msvc 'include')
$libs=@()
$libs += '/LIBPATH:'+(Join-Path $sdk "Lib\$version\um\x64")
$libs += '/LIBPATH:'+(Join-Path $sdk "Lib\$version\ucrt\x64")
$libs += '/LIBPATH:'+(Join-Path $msvc 'lib\x64')
foreach ($name in @('probe','wgc')) {
  & (Join-Path $msvc 'bin\Hostx64\x64\cl.exe') /nologo /LD /EHsc /std:c++17 /bigobj @inc (Join-Path $PSScriptRoot "flicker-$name.cpp") "/Fo$out\$name.obj" "/Fe$out\$name.dll" /link @libs user32.lib comctl32.lib ole32.lib d3d11.lib dxgi.lib windowsapp.lib
  if ($LASTEXITCODE) { throw "Build failed: $name" }
}
