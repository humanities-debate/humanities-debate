// A decoded word is not proof of a system marker. Never strip it automatically.
// Only offer an explicit edit for an untouched local transcription's separate last line.
export function endMarkerEdit(draft: string, recognized: string): string | null {
  if (draft !== recognized) return null
  const match = /\r?\n[ \t]*\(끝\)[ \t]*$/.exec(draft)
  if (!match || !draft.slice(0, match.index).trim()) return null
  return draft.slice(0, match.index)
}
