// Only the same-origin parent launcher may request this existing record screen.
export function attachRecordTools(target: Window, canNavigate: () => boolean, open: () => void) {
  const listener = (event: MessageEvent) => {
    if (target.parent === target || event.source !== target.parent || event.origin !== target.location.origin ||
        event.data?.type !== 'humanities-debate:open-record-tools') return
    if (!canNavigate()) {
      target.parent.postMessage({ type: 'humanities-debate:record-tools-busy' }, target.location.origin)
      return
    }
    open()
  }
  target.addEventListener('message', listener)
  return () => target.removeEventListener('message', listener)
}
