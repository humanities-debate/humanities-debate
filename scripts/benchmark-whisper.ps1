param([string]$Assets, [string]$Audio, [string]$Output, [switch]$Fast)
# Synthetic fixture only. Return timings/counters, never recognized text or raw stderr.
$argsList = @('-m','ggml-base.bin','-f',('"' + $Audio + '"'),'-l','ko','-t','4','-ng','-nt','-otxt','-of',('"' + $Output + '"'))
if ($Fast) { $argsList += @('-bs','1','-bo','1','-nf') }
$timer = [Diagnostics.Stopwatch]::StartNew()
$process = Start-Process -FilePath (Join-Path $Assets 'whisper-cli.exe') -WorkingDirectory $Assets -ArgumentList $argsList -WindowStyle Hidden -PassThru -RedirectStandardOutput ($Output + '.stdout') -RedirectStandardError ($Output + '.stderr')
$cpuMs = 0
while (-not $process.HasExited) {
  try { $process.Refresh(); $cpuMs = [Math]::Max($cpuMs, $process.TotalProcessorTime.TotalMilliseconds) } catch {}
  Start-Sleep -Milliseconds 50
}
$timer.Stop()
$process.WaitForExit()
$stderr = [IO.File]::ReadAllText($Output + '.stderr')
$timings = @{}
foreach ($line in ($stderr -split "`n")) {
  if ($line -match '(load|encode|decode|batchd|total) time\s*=\s*([\d.]+) ms') { $timings[$matches[1]] = [double]::Parse($matches[2], [Globalization.CultureInfo]::InvariantCulture) }
}
@{ wallMs=$timer.ElapsedMilliseconds; sampledCpuMs=$cpuMs; logicalCPUs=[Environment]::ProcessorCount; timings=$timings } | ConvertTo-Json -Compress
Remove-Item -LiteralPath ($Output + '.stdout'), ($Output + '.stderr') -Force
