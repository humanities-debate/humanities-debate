import { useId } from 'react'
import { aiPresets, defaultPreset, presetLabel, presetSettings, settingsAvailable } from '../config/aiPresets'
import type { PresetPurpose } from '../config/aiPresets'
import type { ModelCatalog, ModelSettings, ReasoningEffort } from '../types/debate'

export function AILevelSettings({ purpose, settings, catalog, disabled = false, loading = false, onChange, onReload }: {
  purpose: PresetPurpose; settings: ModelSettings; catalog: ModelCatalog | null
  disabled?: boolean; loading?: boolean; onChange: (settings: ModelSettings) => void; onReload: () => void
}) {
  const name = useId()
  const model = catalog?.models.find(model => model.model === settings.model)
  const available = settingsAvailable(settings, catalog?.models)
  const manual = !settings.preset || settings.preset === 'custom'
  const label = purpose === 'debate' ? '토론 AI 수준' : 'AI 피드백 수준'
  return <div className="ai-level-settings">
    <fieldset className="level-options" disabled={disabled || loading}>
      <legend>{label}</legend>
      {aiPresets.filter(preset => preset.purpose === purpose).map(preset => {
        const supported = settingsAvailable(presetSettings(preset.id), catalog?.models)
        return <label key={preset.id} className={`level-option ${settings.preset === preset.id ? 'selected' : ''}`}>
          <input type="radio" name={name} value={preset.id} checked={settings.preset === preset.id}
            disabled={!supported} onChange={() => onChange(presetSettings(preset.id))} />
          <span><strong>{preset.label}{preset.id === defaultPreset(purpose) ? ' (추천)' : ''}</strong><span>{preset.description}</span>
            {catalog && !supported && <small>현재 계정에서 이 설정을 지원하지 않습니다.</small>}</span>
        </label>
      })}
    </fieldset>
    {manual && <p className="manual-setting">고급 수동 설정 적용: {settings.model} · {settings.reasoningEffort.toUpperCase()}</p>}
    {!manual && <p className="small-label">선택: {presetLabel(settings)}{purpose === 'debate' ? ' · 새 토론 시작 시 확정됩니다.' : ''}</p>}
    {loading ? <p role="status">AI 연결 확인 중…</p> : !available && <div role="alert" className="record-error">
      <p>{catalog ? '선택한 연습 수준을 지원하지 않습니다. 다른 수준을 직접 선택해 주세요.' : 'AI 서버에 연결하지 못했습니다. 서버를 실행한 뒤 다시 확인해 주세요.'} 다른 모델로 자동 전환하지 않습니다.</p>
      <button className="button" disabled={disabled} onClick={onReload}>연결 다시 확인</button>
    </div>}
    <details className="advanced-ai-settings">
      <summary>고급 설정</summary>
      <p className="small-label">직접 변경하면 연습 수준 대신 수동 설정을 적용합니다.</p>
      <label className="wait-setting">AI 모델<select aria-label={`${label} 모델`} value={settings.model} disabled={disabled || loading || !catalog}
        onChange={event => onChange({ model: event.target.value, reasoningEffort: settings.reasoningEffort, preset: 'custom' })}>
        {!model && <option value={settings.model}>{settings.model}</option>}
        {catalog?.models.map(item => <option key={item.model} value={item.model}>{item.displayName}</option>)}
      </select></label>
      <label className="wait-setting">추론 수준<select aria-label={`${label} 추론 수준`} value={settings.reasoningEffort} disabled={disabled || loading || !model}
        onChange={event => onChange({ ...settings, reasoningEffort: event.target.value as ReasoningEffort, preset: 'custom' })}>
        {(['low', 'medium', 'high'] as const).map(effort => <option key={effort} value={effort} disabled={!model?.reasoningEfforts.includes(effort)}>{effort.toUpperCase()}</option>)}
      </select></label>
      <p className="small-label">요청 설정: {settings.model} · {settings.reasoningEffort.toUpperCase()}</p>
      <button className="button" disabled={disabled || loading} onClick={onReload}>모델 목록 다시 확인</button>
    </details>
  </div>
}
