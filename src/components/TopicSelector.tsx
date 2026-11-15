import { practiceTopics } from '../data/topics'
import { MAX_TOPIC_LENGTH } from '../logic/topics'
import type { TopicSelection } from '../logic/topics'

type Props = {
  selection: TopicSelection
  onChange: (selection: TopicSelection) => void
  onDraw: () => void
}
const categories = [...new Set(practiceTopics.map(topic => topic.category))]

export function TopicSelector({ selection, onChange, onDraw }: Props) {
  return <div className="topic-selector">
    <fieldset className="mode-control topic-modes">
      <legend>토론 주제 선택</legend>
      {([['random', '랜덤 주제 출제'], ['list', '목록에서 선택'], ['custom', '직접 입력']] as const).map(([mode, label]) => (
        <label key={mode} className={selection.mode === mode ? 'selected' : ''}>
          <input type="radio" name="topic-mode" checked={selection.mode === mode} onChange={() => onChange({ ...selection, mode })} />{label}
        </label>
      ))}
    </fieldset>
    {selection.mode === 'random' && <div className="topic-random">
      <p id="random-help">시작할 때 무작위로 출제합니다. 미리 뽑으면 해당 주제로 시작합니다. 최근 진행한 5개 주제와 직전 미리보기는 추첨에서 제외합니다.</p>
      <button className="button" onClick={onDraw} aria-describedby="random-help">주제 다시 뽑기</button>
    </div>}
    {selection.mode === 'list' && <label className="topic-field">준비된 주제 30개
      <select value={selection.selectedId} onChange={event => onChange({ ...selection, selectedId: event.target.value })}>
        {categories.map(category => <optgroup key={category} label={category}>
          {practiceTopics.filter(topic => topic.category === category).map(topic => <option key={topic.id} value={topic.id}>{topic.title}</option>)}
        </optgroup>)}
      </select>
    </label>}
    {selection.mode === 'custom' && <label className="topic-field">원하는 토론 주제
      <textarea rows={2} maxLength={MAX_TOPIC_LENGTH} value={selection.customText} onChange={event => onChange({ ...selection, customText: event.target.value })} placeholder="예: 좋은 삶을 판단하는 기준은 개인이 정해야 하는가?" aria-describedby="custom-topic-help" />
      <span id="custom-topic-help">{selection.customText.length}/{MAX_TOPIC_LENGTH}자 · 공백만 입력하면 시작할 수 없습니다. 직접 입력한 주제에는 별도의 상황 설명을 만들지 않습니다.</span>
    </label>}
    <p className="topic-disclaimer">준비된 30개 주제는 자체 제작한 연습용이며 실제 SK하이닉스 기출문제가 아닙니다.</p>
  </div>
}
