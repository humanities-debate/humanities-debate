import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Children, isValidElement } from 'react'
import { debateReducer, initialState } from '../src/logic/debate.ts'
import { decisionTopic } from '../src/data/topics.ts'

test('end marker UI: explicit edit only, preserves deliberate text and records the confirmed edit once', async t => {
  await mkdir('.codex-debate', { recursive: true })
  const file = path.resolve('.codex-debate', `end-marker-ui-${crypto.randomUUID()}.mjs`)
  const bundle = await build({ entryPoints: ['src/components/UserInput.tsx'], bundle: true, write: false, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic' })
  await writeFile(file, bundle.outputFiles[0].text)
  t.after(() => rm(file, { force: true }))
  const previousWindow = globalThis.window
  globalThis.window = { debateDesktop: {} }
  t.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow })
  const { UserInput } = await import(pathToFileURL(file).href)
  let state = debateReducer(initialState, { type: 'START', topic: decisionTopic, timestamp: 1 })
  state = debateReducer(state, { type: 'USER_START', timestamp: 2 })
  const original = '같은 의견입니다. 같은 의견입니다.\n(끝)'
  state = debateReducer(state, { type: 'DRAFT', text: original })
  const props = { paused: false, supported: true, speech: { phase: 'review', finalText: original, interimText: '' },
    onChange: text => { state = debateReducer(state, { type: 'DRAFT', text }) },
    onSubmit: () => { state = debateReducer(state, { type: 'USER_FINISH', generationId: state.generationId, timestamp: 3 }) },
    onCancel() {}, onStartVoice() {}, onStopVoice() {} }
  function editButton(element) {
    if (!isValidElement(element)) return null
    if (element.type === 'button' && element.props.children === '말하지 않은 ‘(끝)’ 지우기') return element
    return Children.toArray(element.props.children).map(editButton).find(Boolean)
  }
  const tree = UserInput({ ...props, draft: state.draft })
  assert.equal(state.draft, original) // Rendering never strips recognized words.
  assert.ok(editButton(tree))
  assert.ok(!editButton(UserInput({ ...props, draft: '직접 수정한 (끝)\n(끝)' })))
  globalThis.window = {}
  assert.ok(!editButton(UserInput({ ...props, draft: original }))) // Chrome path unchanged.
  globalThis.window = { debateDesktop: {} }
  editButton(tree).props.onClick()
  assert.equal(state.draft, '같은 의견입니다. 같은 의견입니다.')
  assert.equal(state.history.length, 0)
  UserInput({ ...props, draft: state.draft }).props.onSubmit({ preventDefault() {} })
  props.onSubmit() // Rapid repeat completion cannot create a second utterance.
  assert.equal(state.history.length, 1)
  assert.equal(state.history[0].text, '같은 의견입니다. 같은 의견입니다.')
})
