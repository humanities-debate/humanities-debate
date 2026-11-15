import { useEffect, useState, useSyncExternalStore } from 'react'
import { criteria, insufficientEvidence, scoreBand, scoreSummary } from '../records/feedback'
import type { Assessment, Evidence, Feedback } from '../records/feedback'
import type { DebateRecord } from '../records/record'
import { createFeedbackTask } from '../records/feedbackTask'
import { requestFeedback } from '../records/feedbackClient'
import type { ModelCatalog } from '../types/debate'
import { presetSettings, presetLabel, settingsAvailable } from '../config/aiPresets'
import { AILevelSettings } from './AILevelSettings'

function EvidenceView({ record, refs }: { record: DebateRecord; refs: Evidence[] }) {
  if (!refs.length) return <p className="muted">확인 가능한 발언 근거가 부족합니다.</p>
  return <details className="feedback-evidence"><summary>근거 발언 원문 보기 ({refs.length})</summary>
    {refs.map(ref => {
      const message = record.messages.find(message => message.id === ref.userId)!
      return <div key={ref.userId}>
        {ref.contextIds.map(id => {
          const context = record.messages.find(message => message.id === id)!
          return <blockquote key={id}><small>이전 AI 발언 · {context.order}번 · {context.speakerName} · {context.id}</small><p>{context.text}</p></blockquote>
        })}
        <blockquote className="original-user"><small>실제 사용자 발언 · {message.order}번 · {message.id}</small><p>{message.text}</p></blockquote>
      </div>
    })}
  </details>
}
function AssessmentView({ title, item, record }: { title: string; item: Assessment; record: DebateRecord }) {
  return <div className="feedback-insight"><h4>{title}</h4><p>{item.text}</p><EvidenceView record={record} refs={item.evidence} /></div>
}
type FeedbackProps = { record: DebateRecord; catalog: ModelCatalog | null; reloadModels: () => void; onSave: (feedback: Feedback, previous?: Feedback) => void }
function FeedbackControls({ record, catalog, reloadModels, onSave }: FeedbackProps) {
  // Feedback always starts at its own standard preset, independently of the debate level.
  const [settings, setSettings] = useState(() => presetSettings('feedback-standard'))
  const [task] = useState(() => createFeedbackTask({ ...record, feedback: undefined }, requestFeedback, feedback => onSave(feedback, record.feedback)))
  const progress = useSyncExternalStore(task.subscribe, task.getSnapshot)
  useEffect(() => () => task.cancel(), [task])
  return <>
    <AILevelSettings purpose="feedback" settings={settings} catalog={catalog} disabled={progress.running} onChange={setSettings} onReload={reloadModels} />
    <button className="button speak-button" disabled={!settingsAvailable(settings, catalog?.models) || progress.running} onClick={() => void task.start(settings)}>
      {progress.running ? '전체 기록 분석 중…' : progress.error ? 'AI 피드백 다시 시도' : 'AI 피드백 분석하기'}
    </button>
    {progress.running && <p role="status">근거 발언과 점수를 확인하고 있습니다. 화면을 이동하면 분석을 취소하고 늦은 응답은 폐기합니다.</p>}
    {progress.error && <p role="alert" className="record-error">{progress.error} 기존 기록과 저장된 피드백은 유지됩니다.</p>}
  </>
}
export function FeedbackPanel({ record, catalog, reloadModels, onSave }: FeedbackProps) {
  const [reanalyzing, setReanalyzing] = useState(false)
  const insufficient = insufficientEvidence(record)
  const feedback = record.feedback
  const total = feedback ? scoreSummary(feedback.categories) : null
  return <section className="feedback-panel" aria-labelledby="feedback-heading">
    <h3 id="feedback-heading">AI 토론 피드백</h3>
    <p className="muted">비공식 연습 평가이며 합격 가능성을 예측하지 않습니다. 1~2점 차이에 큰 의미를 부여하지 마세요. 텍스트만 평가하므로 시선·태도·발음·억양·속도는 평가하지 않습니다. 음성 인식 오류가 있다면 결과를 주의해서 읽어 주세요.</p>
    {(!feedback || reanalyzing) && <>
      {insufficient ? <p className="feedback-hold">{insufficient} AI를 호출하지 않습니다.</p> : <>
        <p>{feedback ? '재분석에는 ChatGPT 사용량이 추가로 발생합니다. 수준을 선택하고 분석 버튼을 눌러야 실행합니다. 성공한 새 결과로 교체하며, 실패하거나 취소하면 이전 결과를 유지합니다.' : '아직 분석하지 않았습니다. 실행하면 주제와 전체 발언을 OpenAI에 전달하며 ChatGPT 계정 사용량을 소모할 수 있습니다.'}</p>
        <FeedbackControls key={feedback?.analyzedAt ?? 'initial'} record={record} catalog={catalog} reloadModels={reloadModels}
          onSave={(next, previous) => { onSave(next, previous); setReanalyzing(false) }} />
        {feedback && <button className="button" onClick={() => setReanalyzing(false)}>재분석 취소</button>}
      </>}
    </>}
    {feedback && total && <>
      <div className="feedback-total"><strong>{total.score === null ? '평가 보류' : `${total.score} / 100점`}</strong>
        <span>{total.score === null ? '평가할 수 있는 항목이 없습니다.' : `${scoreBand(total.score)} · ${total.count}/5개 항목 평균 (반올림)`}</span></div>
      <p className="small-label">5개 항목 동일 가중치(각 20%). 보류 항목은 평균에서 제외합니다. 90–100 매우 우수 · 80–89 우수 · 70–79 양호 · 60–69 개선 필요 · 0–59 집중 개선 필요</p>
      <p className="small-label">분석 수준: {presetLabel(feedback.modelSettings)} · {new Date(feedback.analyzedAt).toLocaleString('ko-KR')} · 열람 시 AI를 다시 호출하지 않습니다. 저장 상태는 위 안내를 확인해 주세요.</p>
      <details className="small-label"><summary>분석 실행 설정 보기</summary><p>SDK 요청 모델: {feedback.modelSettings.model} / {feedback.modelSettings.reasoningEffort.toUpperCase()}</p></details>
      {!reanalyzing && <button className="button" onClick={() => setReanalyzing(true)}>다른 수준으로 다시 분석</button>}
      <AssessmentView title="종합 평가" item={feedback.summary} record={record} />
      <div className="feedback-highlights">
        <AssessmentView title="가장 두드러진 강점" item={feedback.strength} record={record} />
        <AssessmentView title="가장 중요한 개선점" item={feedback.improvement} record={record} />
        <AssessmentView title="다음 토론 목표" item={feedback.nextGoal} record={record} />
      </div>
      <h4>5가지 항목별 평가</h4>
      {feedback.categories.map(category => <article className="feedback-category" key={category.id}>
        <div className="section-heading"><h4>{criteria.find(item => item.id === category.id)!.label}</h4><strong>{category.score === null ? '평가 보류' : `${category.score} / 100`}</strong></div>
        {category.score !== null && <progress value={category.score} max={100} aria-label={`${criteria.find(item => item.id === category.id)!.label} 점수`} />}
        <p><strong>AI 평가 및 근거: </strong>{category.reason}</p><p><strong>시도할 행동: </strong>{category.action}</p>
        <EvidenceView record={record} refs={category.evidence} />
      </article>)}
      {(['strengths', 'weaknesses'] as const).map(kind => <section key={kind} className="feedback-examples">
        <h4>{kind === 'strengths' ? '잘한 발언 TOP 3' : '개선할 발언 TOP 3'}</h4>
        {!feedback[kind].length && <p className="muted">충분한 근거가 있는 사례를 찾지 못해 예시를 채우지 않았습니다.</p>}
        {feedback[kind].map(example => {
          const original = record.messages.find(message => message.id === example.userId)!
          return <article key={example.userId}>
            <blockquote className="original-user"><small>실제 발언 · {original.order}번 · {original.id}</small><p>{original.text}</p></blockquote>
            <EvidenceView record={record} refs={[example]} />
            <p><strong>AI 평가 및 근거 · {example.skill}: </strong>{example.reason}</p>
            {example.rewrite && <div className="feedback-rewrite"><strong>AI 개선 예시 · 실제 발언이 아닙니다</strong><p>{example.rewrite}</p></div>}
          </article>
        })}
      </section>)}
      <h4>다음 연습에서 시도할 행동</h4>
      {feedback.nextActions.map((item, index) => <AssessmentView key={index} title={`행동 ${index + 1}`} item={item} record={record} />)}
    </>}
  </section>
}
