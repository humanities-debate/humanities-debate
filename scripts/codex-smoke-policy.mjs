export const QUESTION = '인문학 토론 주제 하나를 한국어로 제안해줘.'
export const MODEL = 'gpt-6-astra'

// Do not pass API keys, provider overrides, proxies, or inherited agent settings.
export function childEnvironment(source, runtimeHome, tempDirectory) {
  const allowed = new Set(['systemroot', 'windir', 'path', 'pathext', 'userprofile', 'appdata', 'localappdata'])
  const env = Object.fromEntries(Object.entries(source).filter(([key, value]) => allowed.has(key.toLowerCase()) && typeof value === 'string'))
  return { ...env, CODEX_HOME: runtimeHome, TEMP: tempDirectory, TMP: tempDirectory, RUST_LOG: 'off' }
}

export function safeConfig(runtimeHome) {
  return {
    model_provider: 'openai',
    forced_login_method: 'chatgpt',
    cli_auth_credentials_store: 'file',
    project_doc_max_bytes: 0,
    history: { persistence: 'none' },
    log_dir: runtimeHome,
    sqlite_home: runtimeHome,
    check_for_update_on_startup: false,
    analytics: { enabled: false },
    feedback: { enabled: false },
    skills: { include_instructions: false, bundled: { enabled: false } },
    plugins: { _default: { enabled: false } },
    apps: { _default: { enabled: false } },
    features: {
      shell_tool: false, shell_snapshot: false, shell_snapshot_v2: false,
      apps: false, plugins: false, hooks: false, plugin_hooks: false,
      browser_use: false, computer_use: false, in_app_browser: false,
      js_repl: false, code_mode: false, code_mode_only: false,
      multi_agent: false, multi_agent_v2: false,
      view_image: false, image_generation: false,
      memories: false, skip_host_skill_discovery: true,
      skill_search: false, skill_mcp_dependency_install: false,
    },
    developer_instructions: '한국어 토론 연습용 텍스트 질문에만 간결하게 답하세요. 도구 호출, 파일 읽기·쓰기, 명령 실행은 금지합니다. 실제 면접 기출문제라고 주장하지 마세요.',
  }
}

export function validateChatGPTCache(auth) {
  if (auth.auth_mode !== 'chatgpt' || auth.OPENAI_API_KEY || !auth.tokens?.access_token) {
    throw new Error('CHATGPT_LOGIN_REQUIRED: ChatGPT 로그인 캐시가 아닙니다. API 키 인증으로 대체하지 않습니다.')
  }
}

export function redact(text, secrets = []) {
  let result = String(text)
  for (const secret of secrets) if (typeof secret === 'string' && secret.length > 8) result = result.split(secret).join('[REDACTED]')
  return result.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/sk-[\w-]+/g, '[REDACTED]')
    .replace(/eyJ[\w-]+\.[\w-]+(?:\.[\w-]+)?/g, '[REDACTED]')
}
