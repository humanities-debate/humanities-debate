Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
New-Item -ItemType Directory -Force -Path (Join-Path (Get-Location) '.codex-debate') | Out-Null
$voice = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq 'ko-KR' } | Select-Object -First 1
if (-not $voice) { throw 'Korean offline voice unavailable' }
$synth.SelectVoice($voice.VoiceInfo.Name)
$synth.Rate = -1
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$sentences = @('저는 현재 어려움을 겪는 사람들을 먼저 지원해야 한다고 생각합니다.', '그런데 미래 세대를 위해서도 일정한 예산은 남겨야 하지 않을까요?', '상대방 의견도 이해하지만 저는 다른 해결 방법이 필요하다고 봅니다.')
for ($index = 0; $index -lt 3; $index++) {
  $target = Join-Path (Get-Location) ('.codex-debate/korean-' + ($index + 1) + '.wav')
  $synth.SetOutputToWaveFile($target, $format)
  $synth.Speak($sentences[$index])
  $synth.SetOutputToNull()
}
$target = Join-Path (Get-Location) '.codex-debate/korean-long.wav'
$synth.SetOutputToWaveFile($target, $format)
$ssml = '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ko-KR">' + $sentences[0] + '<break time="3s"/>' + $sentences[1] + '<break time="3s"/>' + $sentences[2] + '</speak>'
$synth.SpeakSsml($ssml)
$synth.SetOutputToNull()
$target = Join-Path (Get-Location) '.codex-debate/korean-repeat.wav'
$synth.SetOutputToWaveFile($target, $format)
$synth.SpeakSsml('<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ko-KR">하지만 제 경험상<break time="600ms"/>하지만 제 경험상<break time="600ms"/>하지만 제 경험상 이 방법은 도움이 됩니다.</speak>')
$synth.SetOutputToNull()
$target = Join-Path (Get-Location) '.codex-debate/korean-end-word.wav'
$synth.SetOutputToWaveFile($target, $format)
$synth.Speak('이것으로 제 발언은 끝입니다. 끝까지 들어주셔서 감사합니다.')
$synth.SetOutputToNull()
$synth.Dispose()
Write-Output 'Generated 6 synthetic Korean fixtures offline (not human microphone recordings).'

