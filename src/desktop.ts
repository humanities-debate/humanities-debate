export type DesktopStatus = { phase: 'starting' | 'ready' | 'login-required' | 'logging-in' | 'error'; message: string }
export function aiConnectionHelp() {
  return typeof window !== 'undefined' && window.debateDesktop
    ? '앱 상단에서 ChatGPT 로그인 또는 다시 연결을 눌러주세요. 네트워크 연결도 확인해 주세요.'
    : 'ChatGPT 연결과 로컬 서버, 네트워크 상태를 확인해 주세요. 설치형 앱에서는 상단의 다시 연결을 눌러주세요.'
}
declare global {
  interface Window {
    debateDesktop?: {
      status(): Promise<DesktopStatus>
      login(): Promise<DesktopStatus>
      reconnect(): Promise<DesktopStatus>
      cancelLogin(): Promise<DesktopStatus>
      transcribe(id: string, pcm: Uint8Array): Promise<{ ok: true; text: string } | { ok: false; code: string }>
      cancelSpeech(id: string): Promise<void>
      onStatus(callback: (status: DesktopStatus) => void): () => void
    }
  }
}
