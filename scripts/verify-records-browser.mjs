// Isolated headless Chrome, synthetic text and Mock only. No user browser profile or AI calls.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { preview } from 'vite'
import { fixtureRecord, fixtureFeedback, settings } from '../tests/fixtures/feedback.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = path.join(root, '.codex-debate')
await mkdir(artifacts, { recursive: true })
const profile = await mkdtemp(path.join(artifacts, 'records-ui-'))
const report = { success: false, checks: [] }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result } catch { /* wait for navigation/startup */ }
    await delay(100)
  }
  throw new Error('Browser check timed out: ' + report.stage)
}
let server, chrome, socket
let sequence = 0
const pending = new Map()
function command(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)) }, 30000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params, sessionId }))
  })
}
try {
  report.stage = 'launch'
  server = await preview({ root, configFile: false, preview: { host: '127.0.0.1', port: 0, strictPort: false, open: false } })
  const base = `http://127.0.0.1:${server.httpServer.address().port}`
  chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' })
  chrome.on('error', () => {})
  const endpoint = await until(async () => {
    const [port, route] = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/)
    return `ws://127.0.0.1:${port}${route}`
  }, 60000)
  socket = new WebSocket(endpoint)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    const call = pending.get(message.id)
    if (!call) return
    clearTimeout(call.timer)
    pending.delete(message.id)
    if (message.error) call.reject(new Error(message.error.message)); else call.resolve(message.result)
  })
  const { targetId } = await command('Target.createTarget', { url: base })
  const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true })
  const cdp = (method, params) => command(method, params, sessionId)
  const evaluate = async expression => {
    const result = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description?.split('\n')[0] ?? 'Page evaluation failed')
    return result.result.value
  }
  await cdp('Page.enable')
  const reload = async () => {
    const previous = await evaluate('performance.timeOrigin')
    await cdp('Page.reload')
    await until(() => evaluate(`performance.timeOrigin !== ${previous} && document.querySelector('.site-header') !== null`))
  }
  const click = async label => {
    await until(() => evaluate(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled)`))
    return evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled); if (!b) throw Error('Missing button'); b.click(); return true })()`)
  }
  const select = (selector, value) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.value = ${JSON.stringify(value)}; e.dispatchEvent(new Event('change', { bubbles: true })); })()`)
  const mark = name => { report.checks.push(name); console.log(name) }
  // Synthetic recognition events test only the UI, not a physical microphone/service.
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.recognitionInstances = [];
    window.SpeechRecognition = class {
      starts = 0; stops = 0; aborts = 0;
      start() { this.starts++; window.recognitionInstances.push(this); window.testRecognition = this; this.onstart?.() }
      stop() { this.stops++ }
      abort() { this.aborts++; this.onend?.() }
    };
  ` })
  await reload()
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false })
  await until(() => evaluate("document.querySelector('.session-panel select') !== null"))
  await select('.session-panel select', 'mock')
  report.stage = 'mock-turns'
  await click('시작')
  const readyAt = Date.now()
  await until(() => evaluate("document.querySelectorAll('.participant-row.active').length === 1 && document.querySelector('.typing-dots') !== null"))
  assert.equal(await evaluate("document.querySelector('.topic-panel')"), null)
  await until(() => evaluate("document.querySelector('.participant-ai1 .message-text') !== null"))
  assert.ok(Date.now() - readyAt >= 4500)
  assert.equal(await evaluate("document.querySelectorAll('.participant-row').length"), 4)
  assert.equal(await evaluate("document.querySelector('.participant-ai1 .speaker-status').textContent"), '현재 발언')
  assert.equal(await evaluate("document.querySelector('.controls-top .wait-setting select').value"), '10')
  assert.deepEqual(await evaluate("(() => { const s = getComputedStyle(document.querySelector('.message-text')); return [s.fontSize, s.lineHeight] })()"), ['15px', '27.75px'])
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.participant-row')].map(e => e.id)"), ['participant-user', 'participant-ai1', 'participant-ai2', 'participant-ai3'])
  await evaluate('window.scrollTo(0, 0)')
  assert.ok(await evaluate("document.querySelector('.participant-ai3').getBoundingClientRect().bottom <= innerHeight"), 'Laptop: four rows should fit with the opening Mock speech')
  await evaluate('window.scrollTo(0, 350)')
  assert.ok(await evaluate("Math.abs(document.querySelector('.topic-banner').getBoundingClientRect().top) < 2"))
  assert.ok(await evaluate("document.querySelector('.topic-banner').getBoundingClientRect().height < innerHeight * .35"))
  const laptop = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(path.join(artifacts, 'debate-laptop.png'), Buffer.from(laptop.data, 'base64'))
  mark('7A 수정: 본문 15px/줄 높이 27.75px 복원, 1366×768 첫 발언에서 4행 표시, 고정 주제·강조·타이머 유지')
  await click('일시정지')
  // Layout-only stress content in this throwaway page; never sent to any provider or saved.
  await evaluate(`window.layoutOriginal = { title: document.querySelector('#topic-heading').textContent, speech: document.querySelector('.participant-ai1 .message-text').textContent };
    document.querySelector('#topic-heading').textContent = '회사가 직원의 동의 없이 업무에 AI를 도입하고 평가와 채용을 맡겨도 될까요? '.repeat(5);
    document.querySelector('.participant-ai1 .message-text').textContent = '긴 발언에서도 판단의 이유를 읽을 수 있어야 합니다. 단순히 글을 잘라내면 중요한 조건을 놓칠 수 있습니다. '.repeat(12);`)
  for (const [width, height] of [[1366, 768], [680, 768], [390, 844], [320, 640]]) {
    report.stage = `7A-layout-${width}`
    await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await evaluate('window.scrollTo(0, 0)')
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'))
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.message-text')).fontSize"), width <= 560 ? '14px' : '15px')
    assert.ok(await evaluate("document.querySelector('.topic-banner').getBoundingClientRect().height < innerHeight * .5"))
    assert.ok(await evaluate("(() => { const e = document.querySelector('.participant-ai1 .message-text'); return e.scrollHeight <= e.clientHeight + 1 })()"))
    if (width === 390 || width === 1366) {
      const shot = await cdp('Page.captureScreenshot', { format: 'png' })
      await writeFile(path.join(artifacts, `debate-long-${width}.png`), Buffer.from(shot.data, 'base64'))
    }
    await evaluate("document.querySelector('.topic-explanation-toggle').open = true")
    assert.ok(await evaluate("document.querySelector('.topic-banner').getBoundingClientRect().height < innerHeight * .65"))
    await evaluate("document.querySelector('.topic-explanation-toggle').open = false")
  }
  await evaluate("document.querySelector('#topic-heading').textContent = window.layoutOriginal.title; document.querySelector('.participant-ai1 .message-text').textContent = window.layoutOriginal.speech")
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false })
  await evaluate('window.scrollTo(0, 0)')
  await click('재개')
  const fullLaptop = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(path.join(artifacts, 'debate-laptop-full.png'), Buffer.from(fullLaptop.data, 'base64'))
  mark('7A: 긴 주제·발언 레이아웃, 설명 펼치기, 1366/680/390/320px 가로 넘침 없음, 일시정지·재개')
  await evaluate("(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent === '말하기 (마이크)'); for(let i=0;i<8;i++) b.click() })()")
  await until(() => evaluate("document.querySelector('.participant-user .input-status')?.textContent === '마이크 인식 중'"))
  assert.equal(await evaluate('window.recognitionInstances.length'), 1)
  await evaluate("window.testRecognition.onresult({ resultIndex: 0, results: [{0:{transcript:'확인된 테스트 문장입니다.'},isFinal:true},{0:{transcript:'아직 인식 중'},isFinal:false}] })")
  assert.equal(await evaluate("document.querySelector('.participant-user .message-text').textContent"), '확인된 테스트 문장입니다.')
  assert.ok(await evaluate("document.querySelector('.speech-interim').textContent.includes('아직 인식 중')"))
  assert.equal(await evaluate("document.querySelectorAll('.typing-dots').length"), 0)
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false })
  assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'))
  await evaluate('window.scrollTo(0, 0)')
  const voiceScreen = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(path.join(artifacts, 'debate-voice-390.png'), Buffer.from(voiceScreen.data, 'base64'))
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false })
  await evaluate("(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent === '멈추고 수정'); for(let i=0;i<8;i++) b.click() })()")
  await until(() => evaluate("document.querySelector('.input-status')?.textContent.includes('발언 종료 처리 중')"))
  assert.equal(await evaluate('window.testRecognition.stops'), 1)
  await evaluate('window.testRecognition.onend()')
  await until(() => evaluate("!document.querySelector('#user-input').disabled"))
  // Input and restart in one JS task reproduce React-batched stale closure bugs.
  await evaluate(`(() => {
    const e = document.querySelector('#user-input');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(e, '직접 고친 내용\\n둘째 줄');
    e.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('button')].find(b => b.textContent === '마이크 다시 켜기').click();
  })()`)
  assert.equal(await evaluate("document.querySelector('.participant-user .message-text').textContent"), '직접 고친 내용\n둘째 줄')
  assert.ok(await evaluate("document.querySelector('.user-input-panel').textContent.includes('이전 인식의 미확정 문장')"))
  await evaluate(`(() => {
    const r = window.testRecognition;
    window.staleRecognitionResult = r.onresult;
    r.onresult({resultIndex:0,results:[{0:{transcript:'추가한 확정 문장'},isFinal:true},{0:{transcript:'중단된 임시 문장'},isFinal:false}]});
    [...document.querySelectorAll('button')].find(b => b.textContent === '일시정지').click();
  })()`)
  assert.equal(await evaluate("document.querySelector('#user-input').value"), '직접 고친 내용\n둘째 줄 추가한 확정 문장')
  assert.ok(await evaluate("document.querySelector('.user-input-panel').textContent.includes('중단된 임시 문장')"))
  assert.equal(await evaluate('window.testRecognition.aborts'), 1)
  await click('재개')
  assert.equal(await evaluate('window.recognitionInstances.length'), 2)
  await click('마이크 다시 켜기')
  assert.equal(await evaluate('window.recognitionInstances.length'), 3)
  await evaluate("window.staleRecognitionResult({resultIndex:0,results:[{0:{transcript:'늦게 도착한 옛 문장'},isFinal:true}]})")
  assert.ok(await evaluate("!document.querySelector('.participant-user').textContent.includes('늦게 도착한 옛 문장')"))
  await evaluate("window.testRecognition.onerror({error:'not-allowed'})")
  assert.ok(await evaluate("document.querySelector('.input-status').textContent.includes('마이크 권한 없음')"))
  assert.equal(await evaluate("document.querySelector('#user-input').value"), '직접 고친 내용\n둘째 줄 추가한 확정 문장')
  await click('마이크 다시 켜기')
  await evaluate("window.testRecognition.onerror({error:'network'})")
  assert.ok(await evaluate("document.querySelector('.input-status').textContent.includes('인식 오류')"))
  assert.equal(await evaluate("document.querySelector('#user-input').value"), '직접 고친 내용\n둘째 줄 추가한 확정 문장')
  mark('7B: 같은 화면 갱신 전 연속 시작/종료 1회, 편집→음성 전환 보존, 일시정지·재개 및 늦은 이벤트 차단')
  mark('7B: 모의 권한 거부·네트워크 오류 구분, 미확정 문장 별도 보존, 텍스트 편집 가능')
  await click('입력 취소')
  mark('7A: 모의 마이크 인식 상태·임시/확정 문장 구분, 멈추고 수정, AI 중단 및 입력 취소')
  await select('.input-method select', 'text')
  await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent.includes('텍스트 발언 시작')).click()")
  await until(() => evaluate("document.querySelector('#user-input') !== null"))
  assert.ok(await evaluate("document.querySelector('.participant-user #user-input') !== null"))
  await evaluate("(() => { const e = document.querySelector('#user-input'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(e, '브라우저 검증용 의견입니다.\\n두 번째 줄도 보존합니다.'); e.dispatchEvent(new Event('input', { bubbles: true })); })()")
  await click('발언 완료')
  await until(() => evaluate("document.querySelector('.typing-dots') !== null"))
  await evaluate("document.querySelector('input[name=mode][value=practice]').click()")
  assert.equal(await evaluate("document.querySelector('.participant-ai1 .message-text')"), null)
  await evaluate("document.querySelector('input[name=mode][value=normal]').click()")
  assert.ok(await evaluate("document.querySelector('.participant-ai1 .message-text') !== null"))
  mark('7A: 사용자 행 안의 텍스트 입력, 완료 직후 AI 준비, 일반/실전 모드 표시 복원')
  await select('.input-method select', 'voice')
  await click('말하기 (마이크)')
  await evaluate("window.afterEndResult = window.testRecognition.onresult; window.afterEndResult({resultIndex:0,results:[{0:{transcript:'제출하지 않은 초안'},isFinal:true}]})")
  await click('토론 종료')
  assert.equal(await evaluate('window.testRecognition.aborts'), 1)
  await evaluate("window.afterEndResult({resultIndex:0,results:[{0:{transcript:'종료 후 인식'},isFinal:true}]})")
  await until(() => evaluate("document.querySelector('.record-save-status')?.textContent.includes('저장됨')"))
  assert.equal(await evaluate("document.querySelectorAll('.result-transcript > li').length"), 2)
  assert.ok(await evaluate("document.querySelector('.user-message')?.textContent.includes('두 번째 줄도 보존합니다.')"))
  assert.ok(await evaluate("!document.querySelector('.result-transcript').textContent.includes('제출하지 않은 초안') && !document.querySelector('.result-transcript').textContent.includes('종료 후 인식')"))
  mark('7B: AI 준비 중 마이크 우선, 마이크 사용 중 토론 종료, 초안·종료 후 이벤트는 기록 제외')
  mark('종료 결과: AI 1회 + 사용자 1회, 미완료 AI 제외, 원문 줄바꿈 보존')
  const screenshot = async name => {
    await evaluate('window.scrollTo(0, 0)')
    const image = await cdp('Page.captureScreenshot', { format: 'png' })
    await writeFile(path.join(artifacts, name), Buffer.from(image.data, 'base64'))
  }
  await screenshot('records-desktop.png')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  assert.ok(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'))
  await screenshot('records-mobile.png')
  report.stage = 'reload'
  await reload()
  await until(() => evaluate("[...document.querySelectorAll('button')].some(b => b.textContent === '과거 기록 (1)')"))
  await click('과거 기록 (1)')
  await click('기록 열기')
  assert.equal(await evaluate("document.querySelectorAll('.result-transcript > li').length"), 2)
  mark('실제 페이지 새로고침 후 저장 목록과 상세 발언 복원')
  await click('같은 주제로 다시 연습')
  assert.equal(await evaluate("document.querySelector('.topic-modes input:checked').parentElement.textContent"), '목록에서 선택')
  assert.equal(await evaluate("document.querySelectorAll('.participant-row.active').length"), 0)
  mark('같은 주제 준비 화면: 자동 AI 호출 없이 선택 복원')
  await select('.session-panel select', 'mock')
  report.stage = 'empty-and-quota'
  // Deterministic storage failure in this throwaway profile; no browser settings changed.
  await evaluate("window.originalSetItem = Storage.prototype.setItem; Storage.prototype.setItem = function() { throw new DOMException('test quota', 'QuotaExceededError') }")
  await click('시작')
  await click('토론 종료')
  await until(() => evaluate("document.querySelector('.record-save-status')?.textContent.includes('저장하지 못했습니다')"))
  assert.equal(await evaluate("document.querySelectorAll('.result-transcript > li').length"), 0)
  await evaluate('Storage.prototype.setItem = window.originalSetItem')
  await click('다시 저장')
  await until(() => evaluate("document.querySelector('.record-save-status')?.textContent.includes('저장됨')"))
  mark('빈 토론 종료, 저장 실패 안내, 화면 보존 및 재저장 성공')
  report.stage = 'delete'
  await evaluate('window.confirm = () => true') // Only synthetic records in this isolated profile.
  await click('이 기록 삭제')
  await reload()
  await until(() => evaluate("[...document.querySelectorAll('button')].some(b => b.textContent === '과거 기록 (1)')"))
  await click('과거 기록 (1)')
  assert.equal(await evaluate("document.querySelectorAll('.records-list > li').length"), 1)
  mark('개별 삭제 후 새로고침: 삭제한 세션은 복원되지 않고 다른 기록 유지')
  report.stage = 'feedback-fixture'
  // Browser-only controlled transport. This does NOT count as a real AI verification.
  const feedbackTransport = `(() => {
    const originalFetch = window.fetch.bind(window);
    window.feedbackCalls = 0; window.feedbackCancels = 0; window.feedbackMode = 'success';
    window.fetch = async (url, options = {}) => {
      if (url === '/api/models') return Response.json({ models: ['gpt-6.1-sol', 'gpt-6-luna'].map(model => ({ model, displayName: model, reasoningEfforts: ['low','medium','high'] })), defaultSettings: ${JSON.stringify(settings)} });
      if (url === '/api/session') return Response.json({ token: 'synthetic-local-capability' });
      if (url === '/api/cancel') { window.feedbackCancels++; return Response.json({ cancelled: true }); }
      if (url === '/api/feedback') {
        window.feedbackCalls++;
        const body = JSON.parse(options.body);
        if (window.feedbackMode === 'pending') return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
        if (window.feedbackMode === 'invalid') return Response.json({ error: 'INVALID_EVIDENCE' }, { status: 503 });
        await new Promise(resolve => setTimeout(resolve, 250));
        return Response.json({ id: body.id, feedback: { ...${JSON.stringify(fixtureFeedback())}, analyzedAt: Date.now(), modelSettings: body.request.modelSettings }, ...body.request.modelSettings });
      }
      return originalFetch(url, options);
    };
  })();`
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: feedbackTransport })
  await evaluate(`localStorage.clear(); localStorage.setItem('skhynix-debate:record:feedback-synthetic-record', ${JSON.stringify(JSON.stringify(fixtureRecord()))})`)
  await reload()
  await until(() => evaluate("document.querySelector('.level-options input:checked')?.value === 'debate-standard'"))
  assert.equal(await evaluate("document.querySelector('.advanced-ai-settings').open"), false)
  await evaluate("document.querySelector('input[value=debate-advanced]').click()")
  await until(() => evaluate("document.querySelector('.level-options input:checked')?.value === 'debate-advanced'"))
  await evaluate("document.querySelector('.advanced-ai-settings').open = true")
  await select('[aria-label="토론 AI 수준 추론 수준"]', 'low')
  await until(() => evaluate("document.querySelector('.manual-setting')?.textContent.includes('LOW')"))
  await evaluate("document.querySelector('input[value=debate-standard]').click(); document.querySelector('.advanced-ai-settings').open = false")
  mark('프리셋 UI: 일반 토론 기본값, 심화 선택, 닫힌 고급 설정 및 수동 변경 표시')
  await click('과거 기록 (1)'); await click('기록 열기')
  assert.equal(await evaluate('window.feedbackCalls'), 0)
  assert.equal(await evaluate("document.querySelector('.feedback-panel .level-options input:checked')?.value"), 'feedback-standard')
  await evaluate("window.feedbackMode = 'invalid'")
  await click('AI 피드백 분석하기')
  await until(() => evaluate("document.querySelector('.feedback-panel [role=alert]')?.textContent.includes('일치하지')"))
  assert.equal(await evaluate("document.querySelectorAll('.result-transcript > li').length"), 6)
  mark('피드백 UI: 열람 시 AI 호출 없음, 잘못된 근거 오류 표시 및 원본 기록 보존')
  await evaluate("window.feedbackMode = 'success'; window.originalSetItem = Storage.prototype.setItem; Storage.prototype.setItem = function() { throw new DOMException('test quota', 'QuotaExceededError') }")
  await click('AI 피드백 다시 시도')
  await until(() => evaluate("document.querySelector('.feedback-total')?.textContent.includes('78 / 100')"))
  assert.equal(await evaluate('window.feedbackCalls'), 2)
  assert.equal(await evaluate("document.querySelectorAll('.feedback-category progress').length"), 5)
  assert.ok(await evaluate("document.querySelector('.feedback-rewrite')?.textContent.includes('실제 발언이 아닙니다')"))
  assert.ok(await evaluate("document.querySelector('.record-save-status')?.textContent.includes('저장하지 못했습니다')"))
  await evaluate('Storage.prototype.setItem = window.originalSetItem')
  await click('다시 저장')
  await until(() => evaluate("document.querySelector('.record-save-status')?.textContent.includes('저장됨')"))
  assert.equal(await evaluate('window.feedbackCalls'), 2)
  mark('피드백 UI: 점수 78/100, 5개 막대, 개선 예시 구분, 저장 실패 후 AI 재호출 없이 재저장')
  await click('다른 수준으로 다시 분석')
  assert.ok(await evaluate("document.querySelector('.feedback-panel').textContent.includes('사용량이 추가로 발생')"))
  await evaluate("document.querySelector('input[value=feedback-deep]').click()")
  assert.equal(await evaluate('window.feedbackCalls'), 2)
  await click('AI 피드백 분석하기')
  await until(() => evaluate("JSON.parse(localStorage.getItem('skhynix-debate:record:feedback-synthetic-record')).feedback.modelSettings.preset === 'feedback-deep'"))
  assert.equal(await evaluate('window.feedbackCalls'), 3)
  assert.ok(await evaluate("document.querySelector('.feedback-total')?.textContent.includes('78 / 100')"))
  assert.equal(await evaluate("document.querySelectorAll('.result-transcript > li').length"), 6)
  mark('프리셋 UI: 일반 분석 기본값, 심층 재분석 사전 안내·명시적 실행·프리셋 저장, 동일 점수 구조')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false })
  await evaluate("document.querySelector('.feedback-panel').scrollIntoView()")
  const feedbackImage = await cdp('Page.captureScreenshot', { format: 'png' })
  await writeFile(path.join(artifacts, 'feedback-desktop.png'), Buffer.from(feedbackImage.data, 'base64'))
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  assert.ok(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'))
  await reload()
  await click('과거 기록 (1)'); await click('기록 열기')
  await until(() => evaluate("document.querySelector('.feedback-total')?.textContent.includes('78 / 100')"))
  assert.equal(await evaluate('window.feedbackCalls'), 0)
  await evaluate('window.confirm = () => true')
  await click('이 기록 삭제')
  assert.equal(await evaluate("localStorage.getItem('skhynix-debate:record:feedback-synthetic-record')"), null)
  mark('피드백 UI: 새로고침 후 결과 재사용(추가 호출 0회), 기록 삭제 시 피드백 함께 삭제')
  await evaluate(`localStorage.setItem('skhynix-debate:record:feedback-synthetic-record', ${JSON.stringify(JSON.stringify(fixtureRecord()))})`)
  await click('다시 불러오기'); await click('기록 열기')
  await evaluate("window.feedbackMode = 'pending'")
  await click('AI 피드백 분석하기')
  await until(() => evaluate('window.feedbackCalls === 1'))
  assert.ok(await evaluate("[...document.querySelectorAll('button')].some(b => b.textContent === '전체 기록 분석 중…' && b.disabled)"))
  await click('과거 토론 보기')
  await until(() => evaluate('window.feedbackCancels === 1'))
  await click('기록 열기')
  assert.equal(await evaluate("document.querySelector('.feedback-total')"), null)
  assert.equal(await evaluate('window.feedbackCalls'), 1)
  mark('피드백 UI: 분석 중 버튼 비활성화, 화면 이동 시 취소, 재열람 자동 호출 없음')
  report.success = true
} catch (error) {
  report.error = error.message
  process.exitCode = 1
} finally {
  if (socket?.readyState === WebSocket.OPEN) await command('Browser.close').catch(() => {})
  socket?.close()
  if (chrome && chrome.exitCode === null) await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), delay(3000)])
  if (chrome && chrome.exitCode === null) chrome.kill()
  if (server) await new Promise(resolve => server.httpServer.close(resolve))
  if (path.dirname(profile) !== artifacts || !path.basename(profile).startsWith('records-ui-')) throw new Error('Invalid cleanup target')
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => { report.cleanupWarning = 'Test profile could not be removed' })
  await writeFile(path.join(artifacts, 'records-browser-verification.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
