import { useEffect, useState } from 'react'
import { ParticipantRow } from './components/ParticipantRow'
import { participants } from './data/mockDebate'
import { TopicSelector } from './components/TopicSelector'
import { TopicExplanation } from './components/TopicExplanation'
import { drawTopic, initialTopicSelection, selectionPreview, topicForStart } from './logic/topics'
import { AI_TYPING_MS, participantView, WAIT_SECONDS_OPTIONS } from './logic/debate'
import { useDebate } from './hooks/useDebate'
import { useRecords } from './hooks/useRecords'
import { DebateResult, RecordLibrary } from './components/RecordScreens'
import { practiceTopics } from './data/topics'
import { UserInput } from './components/UserInput'
import { AILevelSettings } from './components/AILevelSettings'
import { presetSettings, presetLabel, settingsAvailable } from './config/aiPresets'
import './App.css'
import type { DebateTopic } from './types/debate'
import { speechStatus } from './speech/types'
import { attachRecordTools } from './logic/launcherNavigation'

function formatTime(seconds: number) {
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}

function App() {
  const { state, send, running, elapsed, now, speech, startSpeaking, restartMicrophone, models } = useDebate()
  const records = useRecords(state)
  const [view, setView] = useState<'debate' | 'result' | 'library'>('debate')
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null)
  const selectedEntry = records.entries.find(entry => entry.record.id === (selectedRecordId ?? records.currentRecord?.id))
  const displayedRecord = selectedEntry?.record ?? (selectedRecordId === null ? records.currentRecord : null)
  const [inputMode, setInputMode] = useState<'voice' | 'text'>(() => speech.supported ? 'voice' : 'text')
  const stopping = speech.snapshot.phase === 'stopping'
  const speaking = state.status === 'userSpeaking'
  const paused = state.status === 'paused'
  const canStart = state.status === 'idle' || state.status === 'finished'
  useEffect(() => {
    let pending: number | undefined
    const detach = attachRecordTools(window, () => canStart, () => {
      records.library.refresh()
      setView('library')
      pending = window.requestAnimationFrame(() => {
        const transfer = document.getElementById('record-transfer') as HTMLDetailsElement | null
        if (transfer) { transfer.open = true; transfer.scrollIntoView({ block: 'start' }) }
      })
    })
    return () => { detach(); if (pending !== undefined) window.cancelAnimationFrame(pending) }
  }, [canStart, records.library])
  const validModel = settingsAvailable(state.modelSettings, models.catalog?.models)
  const [topicSelection, setTopicSelection] = useState(initialTopicSelection)
  const preview = selectionPreview(topicSelection)
  const displayedTopic = canStart ? preview : state.topic
  const recentTopicIds = state.sessions.map(session => session.topic.id)
  function prepareDebate(topic?: DebateTopic) {
    if (!canStart) return
    setTopicSelection(topic ? topic.source === 'prepared' && practiceTopics.some(item => item.id === topic.id)
      ? { ...initialTopicSelection, mode: 'list', selectedId: topic.id }
      : { ...initialTopicSelection, mode: 'custom', customText: topic.title }
      : initialTopicSelection)
    setView('debate')
    setSelectedRecordId(null)
  }
  function deleteRecord(id: string) {
    if (!window.confirm('이 토론 기록과 저장된 피드백을 삭제할까요? 삭제하면 복원할 수 없습니다.')) return
    if (records.library.remove(id) && view === 'result') { setView('library'); setSelectedRecordId(null) }
  }
  function startDebate() {
    if (!canStart) return
    if (state.engine === 'real' && (!validModel || models.loading)) return
    const topic = topicForStart(topicSelection, recentTopicIds)
    if (!topic) return
    send({ type: 'START', topic, timestamp: Date.now() })
    setTopicSelection({ ...topicSelection, previewId: null })
  }
  const secondsLeft = state.waitUntil === null ? 0 : Math.min(state.waitSeconds, Math.max(0, Math.ceil((state.waitUntil - now) / 1000)))
  const statusText = {
    idle: '시작 전', aiTyping: 'AI 발언 준비 중', aiShowing: '사용자 발언 기회',
    userSpeaking: '내 발언 입력 중', paused: '일시정지', finished: '연습 종료',
  }[state.status]
  const hint = {
    idle: '시작을 누르면 AI 지원자들이 자동으로 토론을 이어갑니다.',
    aiTyping: `AI가 발언을 준비합니다(최소 ${AI_TYPING_MS / 1000}초). 응답이 늦으면 더 기다립니다. 말하기로 끼어들 수 있습니다.`,
    aiShowing: `자유롭게 말하기를 누르세요. 약 ${secondsLeft}초 뒤 다음 AI가 발언을 준비합니다.`,
    userSpeaking: '말하거나 입력하는 동안 AI는 기다립니다. 발언 종료 시 마지막 인식 결과를 확인한 뒤 기록합니다.',
    paused: `토론과 진행 시간이 멈췄습니다. 재개하면 준비 중이던 AI는 다시 준비하고, 대기 시간은 ${state.waitSeconds}초부터 시작합니다.`,
    finished: '연습을 마쳤습니다. 전체 대화에서 숨겨진 발언도 확인할 수 있습니다.',
  }[state.status]

  const microphoneStatus = paused ? '발언 일시정지' : speech.snapshot.phase === 'idle' ? '텍스트 입력 중' : speechStatus(speech.snapshot)
  const speakingControls = <div className="speaking-controls">
    <button className={`button speak-button ${speaking ? 'speaking' : ''}`} disabled={!running || stopping || (speaking && !speech.busy)} onClick={() => speaking ? speech.stop('submit') : startSpeaking(inputMode)} aria-controls="participant-user">
      {stopping ? '마지막 결과 확인 중' : speaking ? speech.busy ? '발언 종료' : '내 발언 입력 중' : inputMode === 'voice' ? '말하기 (마이크)' : '텍스트 발언 시작'}
    </button>
    <label className="input-method">입력 방식 <select value={inputMode} disabled={speaking || paused} onChange={(event) => setInputMode(event.target.value as 'voice' | 'text')}><option value="voice" disabled={!speech.supported}>마이크 음성</option><option value="text">텍스트 직접 입력</option></select></label>
  </div>
  const userInput = (speaking || (paused && state.resumeStatus === 'userSpeaking')) && (
    <UserInput draft={state.draft} paused={paused} speech={speech.snapshot} supported={speech.supported}
      onStartVoice={restartMicrophone} onStopVoice={speech.stop}
      onChange={(text) => send({ type: 'DRAFT', text })}
      onSubmit={() => send({ type: 'USER_FINISH', generationId: state.generationId, timestamp: Date.now() })}
      onCancel={() => send({ type: 'USER_CANCEL', generationId: state.generationId, timestamp: Date.now() })} />
  )

  return (
    <main className={`app-shell ${view === 'debate' && !canStart ? 'is-debating' : ''}`}>
      <header className="site-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">토</span>
          <div><p className="eyebrow">SK하이닉스 인문학 토론</p><h1>토론 연습실</h1></div>
        </div>
        <div className="header-labels"><span className="badge">비공식 면접 연습 서비스</span><span className="badge demo-badge">{state.engine === 'real' ? '실제 AI 모드' : '데모 모드 · Mock'}</span></div>
      </header>

      {canStart && <nav className="record-navigation" aria-label="연습과 기록">
        <button className="button" disabled={!canStart} onClick={() => setView('debate')}>토론 연습</button>
        <button className="button" disabled={!canStart} onClick={() => { records.library.refresh(); setView('library') }}>과거 기록 ({records.entries.length})</button>
        {records.entries.some(entry => !entry.saved) && <span className="record-error" role="status">미저장 기록이 있습니다. 과거 기록에서 다시 저장해 주세요.</span>}
      </nav>}

      {view === 'library' && <RecordLibrary entries={records.entries} loadError={records.loadError}
        onOpen={id => { setSelectedRecordId(id); setView('result') }} onDelete={deleteRecord} onRetry={records.library.retry} onReload={records.library.refresh} />}
      {view === 'result' && (displayedRecord ? <DebateResult key={displayedRecord.id} record={displayedRecord} entry={selectedEntry}
        catalog={models.catalog} reloadModels={models.reload}
        onFeedback={(feedback, previous) => records.library.attachFeedback(displayedRecord.id, feedback, previous)}
        onRetry={records.library.retry} onDelete={deleteRecord} onNew={() => prepareDebate()} onRepeat={() => prepareDebate(displayedRecord.topic)} onLibrary={() => setView('library')} />
        : <p role="status">기록을 찾을 수 없습니다. 과거 기록에서 다시 확인해 주세요.</p>)}

      {view === 'debate' && <>

      <section className="topic-banner" aria-labelledby="topic-heading">
        <p className="eyebrow">{canStart ? '다음 토론 주제' : '현재 토론 주제'}{displayedTopic ? ` · ${displayedTopic.category}` : ''}</p>
        <h2 id="topic-heading" tabIndex={0} aria-live="polite">{displayedTopic?.title ?? (topicSelection.mode === 'random' ? '시작하면 랜덤 주제가 출제됩니다.' : '토론하고 싶은 주제를 입력해 주세요.')}</h2>
        {!canStart && <TopicExplanation key={state.sessionId} context={displayedTopic?.context} collapsible initiallyOpen />}
        {!canStart && <div className="live-toolbar">
          <div className="live-progress"><strong className="timer" aria-label="진행 시간">{formatTime(elapsed)}</strong><span>{speaking ? microphoneStatus : state.status === 'aiShowing' ? `다음 AI 준비 ${secondsLeft}초 후 · 발언 가능` : statusText}</span></div>
          {speakingControls}
          <div className="session-actions">
            <button className="button" onClick={() => send({ type: paused ? 'RESUME' : 'PAUSE', timestamp: Date.now() })}>{paused ? '재개' : '일시정지'}</button>
            <button className="button" onClick={() => { send({ type: 'END', timestamp: Date.now() }); setSelectedRecordId(null); setView('result') }}>토론 종료</button>
          </div>
        </div>}
      </section>

      {canStart && <section className="topic-panel" aria-label="토론 설정과 진행">
        <div className="topic-copy">
          <TopicExplanation context={displayedTopic?.context} />
          <p className="muted">생각의 근거를 말하고, 서로 다른 관점을 나눠보세요.</p>
          <TopicSelector selection={topicSelection} onChange={setTopicSelection} onDraw={() => {
            const topic = drawTopic(recentTopicIds, topicSelection.previewId)
            setTopicSelection({ ...topicSelection, previewId: topic.id })
          }} />
        </div>
        <div className="session-panel">
          <label className="wait-setting">AI 모드
            <select value={state.engine} disabled={running} onChange={(event) => send({ type: 'ENGINE', engine: event.target.value as 'real' | 'mock' })}>
              <option value="real">실제 AI · ChatGPT 계정</option><option value="mock">Mock · 데모 모드</option>
            </select>
          </label>
          {state.engine === 'real' && <AILevelSettings purpose="debate" settings={state.modelSettings ?? presetSettings('debate-standard')}
            catalog={models.catalog} loading={models.loading} disabled={!canStart}
            onChange={settings => send({ type: 'MODEL_SETTINGS', settings })} onReload={models.reload} />}
          <div className="timer-line">
            <div><span className="small-label">진행 시간</span><strong className="timer">{formatTime(elapsed)}</strong></div>
            <span className={`session-state ${running ? 'is-running' : ''}`}>{statusText}</span>
          </div>
          <div className="session-actions">
            <button className="button primary" disabled={!canStart || (topicSelection.mode !== 'random' && !preview) || (state.engine === 'real' && (!validModel || models.loading))} onClick={startDebate}>{state.status === 'finished' ? '다시 시작' : '시작'}</button>
          </div>
        </div>
      </section>}

      {!canStart && <div className="live-notices">
        {speech.snapshot.message && <p role={speech.snapshot.phase === 'error' ? 'alert' : 'status'}>{speech.snapshot.message}</p>}
        {state.error && <p role="alert">{state.error}</p>}
      </div>}

      <section className="debate-section" aria-labelledby="participants-heading">
        <div className="section-heading"><h2 id="participants-heading">토론 참여자 <span>4명</span></h2><p>나와 AI 지원자 3명 · {state.engine === 'real' ? '실제 AI 생성 발언' : '규칙 기반 Mock 발언'}</p></div>
        <div className="participant-list">
          {participants.map((participant) => <ParticipantRow key={participant.id} participant={participant} {...participantView(state, participant.id)} liveText={participant.id === 'user' ? state.draft : undefined} interimText={participant.id === 'user' ? speech.snapshot.interimText : undefined}
            inputStatus={participant.id === 'user' && userInput ? microphoneStatus : undefined}>
            {participant.id === 'user' ? userInput : undefined}
          </ParticipantRow>)}
        </div>
      </section>

      <section className="controls-panel" aria-label="토론 조작">
        <div className="controls-top">
          {canStart && speakingControls}
          <fieldset className="mode-control">
            <legend>발언 표시</legend>
            <label className={state.mode === 'normal' ? 'selected' : ''}><input type="radio" name="mode" value="normal" checked={state.mode === 'normal'} onChange={() => send({ type: 'MODE', mode: 'normal' })} />일반 모드</label>
            <label className={state.mode === 'practice' ? 'selected' : ''}><input type="radio" name="mode" value="practice" checked={state.mode === 'practice'} onChange={() => send({ type: 'MODE', mode: 'practice' })} />실전 모드</label>
          </fieldset>
          <label className="wait-setting">
            AI 발언 간 대기
            <select value={state.waitSeconds} onChange={(event) => send({ type: 'WAIT_SETTING', seconds: Number(event.target.value), timestamp: Date.now() })} aria-describedby="wait-setting-help">
              {WAIT_SECONDS_OPTIONS.map((seconds) => <option key={seconds} value={seconds}>{seconds}초</option>)}
            </select>
          </label>
          <button className="button next-button" disabled={state.status !== 'aiShowing'} onClick={() => send({ type: 'NEXT', generationId: state.generationId, timestamp: Date.now() })}>다음 발언 <span aria-hidden="true">→</span></button>
        </div>
        <details className="controls-description">
          <summary>진행 안내 및 AI 설정{!canStart && state.modelSettings ? ` · ${presetLabel(state.modelSettings)}` : ''}</summary>
          {!canStart && <label className="wait-setting">AI 모드 (일시정지 중 변경 가능)
            <select value={state.engine} disabled={running} onChange={event => send({ type: 'ENGINE', engine: event.target.value as 'real' | 'mock' })}>
              <option value="real">실제 AI · ChatGPT 계정</option><option value="mock">Mock · 데모 모드</option>
            </select>
          </label>}
          <p role="status">{hint}</p>
          {!canStart && <p>{state.topic?.source === 'custom' ? '직접 입력한 연습 주제입니다.' : '자체 제작한 연습 주제이며 실제 기출문제가 아닙니다.'} 주제 변경은 토론 종료 후 가능합니다.</p>}
          {!speech.supported && <p>이 브라우저는 음성 인식을 지원하지 않아 텍스트 입력을 제공합니다.</p>}
          <p>{window.debateDesktop
            ? '마이크 음성은 PC의 Whisper base 다국어 모델로 처리합니다. 음성은 외부로 보내지 않으며 변환용 임시 오디오는 처리 후 삭제합니다. 발언 종료 후 결과를 확인하고 제출해 주세요.'
            : '음성 인식은 브라우저의 외부 서비스로 오디오를 전송할 수 있습니다. 이 앱은 녹음 파일을 저장하지 않습니다.'}</p>
          <p>{state.mode === 'normal' ? '일반 모드 · 참가자별 최근 발언을 유지합니다.' : '실전 모드 · 새 발언이 시작되면 이전 발언을 숨깁니다.'} 원본 기록은 유지됩니다.</p>
          <p>AI 발언 후 {state.waitSeconds}초 대기 → AI 준비 최소 {AI_TYPING_MS / 1000}초 순서로 진행됩니다. 내 발언이 최종 확정되면 대기 없이 바로 AI 준비를 시작합니다.</p>
          <p>{state.engine === 'real' ? '실제 AI 모드에서는 주제와 대화 내용을 OpenAI로 전송하며, 연결한 ChatGPT 계정의 허용된 사용량을 사용합니다. AI 발언에는 오류가 있을 수 있습니다.' : '데모 모드에서는 AI 생성 요청을 보내지 않습니다.'} AI 모드는 시작 전 또는 일시정지 중 변경할 수 있습니다.</p>
          <p id="wait-setting-help">대기 중 설정을 변경하면 선택한 시간으로 다시 기다립니다. ‘다음 발언’은 AI 발언 뒤의 대기만 건너뜁니다.</p>
        </details>
      </section>

      <details className="history-panel">
        <summary>현재 토론 기록 <span>{canStart ? 0 : state.history.filter(message => message.sessionId === state.sessionId).length}개 발언</span></summary>
        <p className="history-note">숨긴 발언도 원문으로 남습니다. 종료한 토론은 이 브라우저에 저장되며 과거 기록에서 볼 수 있습니다. 진행 중인 토론은 새로고침하면 초기화됩니다.</p>
        {canStart ? <p className="empty-history">진행 중인 토론이 없습니다. 종료한 토론은 과거 기록에서 확인하세요.</p> : state.sessions.filter(session => session.id === state.sessionId).map(session => (
          <section className="history-session" key={session.id} aria-labelledby={`history-session-${session.id}`}>
            <h3 id={`history-session-${session.id}`}>연습 {session.id} · {session.topic.title}</h3>
            <TopicExplanation context={session.topic.context} collapsible />
            <p className="history-note">{session.topic.category} · {session.topic.source === 'custom' ? '직접 입력' : '자체 제작 연습 주제'} · {session.endedAt === null ? '진행 중' : '종료'}</p>
            {session.modelSettings && <details className="history-note"><summary>AI 연습 수준: {presetLabel(session.modelSettings)}</summary><p>요청 모델: {session.modelSettings.model} · {session.modelSettings.reasoningEffort.toUpperCase()}</p></details>}
            {!state.history.some(message => message.sessionId === session.id) && <p className="empty-history">기록된 발언이 없습니다.</p>}
          <ol className="history-list">{state.history.filter(message => message.sessionId === session.id).map((message) => (
            <li key={message.id}>
              <div className="history-meta"><strong>{participants.find((participant) => participant.id === message.speakerId)?.name}</strong><span>연습 {message.sessionId} · {message.id} · {message.isUser ? '사용자 입력' : message.source === 'real' ? '실제 AI' : 'Mock AI'} · {new Date(message.timestamp).toLocaleTimeString('ko-KR', { hour12: false })}</span></div>
              <p>{message.text}</p>
            </li>
          ))}</ol>
          </section>
        ))}
      </details>
      </>}
      <footer>SK하이닉스 공식 서비스 및 공식 평가 도구가 아닙니다. 참가자 구성과 토론 주제는 연습을 위한 예시입니다.</footer>
    </main>
  )
}

export default App
