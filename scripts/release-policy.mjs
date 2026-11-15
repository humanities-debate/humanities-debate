// Read-only publication guards. Return rule names, never matching secret values.
export function inspectReleaseText(text, privateLabels = []) {
  const rules = {
    apiKey: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/,
    githubToken: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/,
    jwt: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/,
    privateKey: /-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----/,
    credentialLiteral: /["'](?:access_token|refresh_token|id_token|client_secret)["']\s*:\s*["'][A-Za-z0-9._-]{30,}["']/,
    privateComputerPath: /[A-Z]:[\\/]Users[\\/][^\\/\s"'<>]+/i,
  }
  const found = Object.entries(rules).filter(([, expression]) => expression.test(text)).map(([name]) => name)
  if (privateLabels.some(label => label.length >= 4 && text.toLowerCase().includes(label.toLowerCase()))) found.push('privateIdentity')
  return found
}

export const privateReleasePath = value => /(^|\/)(?:auth\.json(?:\.[^/]*)?|chatgpt-auth\.json(?:\.[^/]*)?|\.env(?:\.[^/]*)?|\.git|\.codex(?:-debate|-smoke)?|official-auth|codex-auth|browser|Local Storage|sessions)(\/|$)/i.test(value)
