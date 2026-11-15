export function chromeStartupMessage(code) {
  return ({
    CHROME_NOT_INSTALLED: 'Google Chrome을 찾을 수 없습니다. Google 공식 사이트에서 Chrome을 설치한 뒤 다시 실행해 주세요.',
    EADDRINUSE: '기존 포트가 사용 중입니다. 사용 중인 프로그램을 종료한 뒤 다시 실행해 주세요. 기록 보호를 위해 포트를 변경하지 않았습니다.',
    PROFILE_PERMISSIONS: '사용자 데이터 폴더의 권한을 설정하지 못했습니다. 현재 Windows 사용자로 다시 실행해 주세요.',
    INVALID_PORT: '저장된 연결 설정을 읽을 수 없습니다. 기록을 보존한 채 점검이 필요합니다. 데이터 폴더를 삭제하지 마세요.',
  })[code] || '앱을 시작하지 못했습니다. Chrome 설치와 앱 파일을 확인한 뒤 다시 실행해 주세요.'
}
