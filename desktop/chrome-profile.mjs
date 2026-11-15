import path from 'node:path'

export function chromeProfilePaths({ root, appData, packaged, profile = 'A', verificationRoot }) {
  if (!/^[a-zA-Z0-9-]{1,40}$/.test(profile) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(profile)) throw new Error('INVALID_PROFILE')
  if (verificationRoot && !path.isAbsolute(verificationRoot)) throw new Error('INVALID_TEST_ROOT')
  const base = verificationRoot || (packaged ? path.join(appData, 'HumanitiesDebateChrome', 'profiles') : path.join(root, '.codex-debate', 'chrome-prototype'))
  const dataRoot = path.join(base, profile)
  return { dataRoot, authHome: path.join(dataRoot, 'codex-auth'), browser: path.join(dataRoot, 'browser'), launcher: path.join(dataRoot, 'launcher') }
}
