# Humanities Debate v1.0.0

무료 개인·비상업 로컬 인문학 토론 연습 프로그램입니다. SK하이닉스나 OpenAI의 공식 채용 서비스·평가 도구가 아닙니다.

## 포함 기능

- 서로 다른 성격의 AI 지원자 3명과 한국어 자유 토론
- 2:1 초기 입장, 논점·contribution 관리, 사용자 질문 대상에 따른 다음 발언자 선택
- Chrome 한국어 음성 입력과 텍스트 입력, 사용자 발언 우선권 및 오래된 AI 응답 폐기
- 일반·심화 토론, 일반·실전 표시, 토론 기록·복원과 실제 발언에 근거한 100점 연습 피드백

## 다운로드·파일 확인

- Windows x64: [HumanitiesDebate-Setup-1.0.0-x64.exe](https://github.com/humanities-debate/humanities-debate/releases/download/v1.0.0/HumanitiesDebate-Setup-1.0.0-x64.exe)
- 파일 크기: 121,625,260바이트 (약 121.6 MB / 116 MiB)
- 생성: 2026-11-16 01:33:56 한국시간
- SHA-256: `be453654462e1e94f86e7cfd5bc177ef05324c923fc4a59a4dd6299e011ae0f0`
- 별도 SHA256SUMS.txt도 제공합니다. 다운로드한 파일을 Defender로 검사하고 해시를 비교하세요.

이 EXE는 개발 소스 0d6d40b730ab375bcba6ed3795e230e22cade950에서 생성한 뒤 사용자가 직접 설치·ChatGPT 연결·핵심 토론 기능을 확인한 동일 파일입니다. 이번 공개 과정에서 앱을 재빌드하지 않았습니다. 다른 PC·계정의 동작까지 확인한 것은 아닙니다.

## 설치·실행

1. Windows x64 PC에 Google Chrome 정식 버전과 인터넷 연결을 준비합니다.
2. 이 Organization의 Release에서 파일을 받고 이름·출처·SHA-256을 확인합니다.
3. 디지털 서명은 없습니다. SmartScreen 경고가 표시될 수 있으며 게시자가 확인되지 않을 수 있습니다. 보안 기능을 끄거나 경고를 무조건 무시하지 마세요. 신뢰할 수 없거나 해시가 다르면 실행하지 않습니다. 설치 여부는 사용자가 결정합니다.
4. EXE를 실행해 설치한 뒤 시작 메뉴의 Humanities Debate를 엽니다. VS Code·Node.js·터미널은 필요하지 않습니다.
5. 공식 Continue with ChatGPT로 본인 계정에 로그인하고 구독 사용에 동의합니다.
6. Windows와 Chrome 마이크 권한을 허용한 뒤 주제를 선택해 토론합니다. 마이크가 어렵다면 텍스트 입력을 사용합니다.
7. 종료 후 기록·100점 피드백을 확인할 수 있습니다. 피드백 생성은 AI 사용량이 발생하며 저장된 결과 재열람은 추가 AI 요청 없이 가능합니다.

[초보자 설치·사용 안내](https://humanities-debate.github.io/guide.html) · [홈페이지](https://humanities-debate.github.io/)

## ChatGPT 구독·사용량

프로그램 자체는 무료입니다. 실제 AI 기능에는 공식 SIWC에서 이용 자격이 있는 **본인 ChatGPT Plus 또는 Pro 구독**, 본인 로그인과 사용 동의가 필요합니다. 사용자 본인의 허용된 계정 사용량을 이용하며 개발자의 계정·API 키를 공유하지 않습니다. 모든 계정·작업공간·모델의 이용이나 무제한 사용을 보장하지 않습니다. 계정·앱 한도는 앱 설정의 ChatGPT 사용량 관리에서 확인합니다.

[공식 구독 연동 안내](https://developers.openai.com/siwc/token-sharing-open-source) · [적격 Plus/Pro 안내](https://developers.openai.com/siwc/quickstart)

## 개인정보·음성 처리

인증 토큰은 로컬 Windows 보호 저장 방식으로 처리하며 Chrome UI·배포 파일에 제공하지 않습니다. AI 토론·피드백 요청 때 주제와 대화 내용은 OpenAI로 전송됩니다. Chrome 음성 인식은 외부 온라인 음성 서비스를 사용할 수 있으므로 음성이 전부 PC 안에서만 처리되는 버전이 아닙니다.

토론 기록은 Windows 사용자·연결 계정별 로컬 데이터로 관리합니다. 개발자에게 비밀번호·토큰·인증 폴더·개인 발언 원문을 보내지 마세요. 삭제·재설치·업데이트 전 앱의 기록 백업 기능을 사용하세요. 제거는 Windows 설정의 설치된 앱에서 진행합니다.

## 라이선스

독립 작성 앱 코드는 MIT이며 [LICENSE](./LICENSE)와 [LICENSE_SCOPE.md](./LICENSE_SCOPE.md)에 범위를 명시했습니다. 포함된 **SIWC DevKit 및 수정 어댑터는 별도 Noncommercial License v1.0**이며 전체 설치판을 상업적 사용까지 허용하는 단일 MIT 제품으로 표시하지 않습니다. 무료라도 사업·고용주·고객 업무 또는 상업적 이익을 위한 사용에는 이 DevKit 라이선스가 권한을 부여하지 않습니다. [NOTICE.md](./NOTICE.md), licenses/DEVKIT_LICENSE.txt와 제3자 고지를 확인하세요.

## 알려진 제한 사항

- 코드 서명 없음, 자동 업데이트 미지원입니다. 새 버전은 공식 Release에서 직접 확인·다운로드합니다. 기존 기록을 지우며 업데이트하지 마세요.
- 다른 실제 PC와 다른 실제 ChatGPT 계정을 이용한 실사용 검사는 아직 미검증입니다.
- 음성 인식은 네트워크·브라우저 서비스·장치 권한에 영향을 받으며 텍스트 입력으로 대체할 수 있습니다.
- AI 발언·100점 피드백은 오류가 있을 수 있는 비공식 연습 결과입니다. 공식 면접 점수·채용 결과를 보장하지 않습니다.
- 최초 로그인 후 1회 구독 사용 안내창은 아직 없으며, 상시 구독 사용 안내·공식 OAuth 동의·사용량 관리 링크를 제공합니다. [공식 UI 가이드](https://developers.openai.com/siwc/ui-ux-guidelines)와 이 차이가 있습니다. OpenAI의 개별 앱 승인이나 완전한 가이드 적합성 인증을 받았다고 주장하지 않습니다.
- 검증 환경의 build·lint 및 테스트 254개, 패키지 무결성·보안 Fuse·민감정보 검사가 통과했고 Defender는 위협을 보고하지 않았습니다. 런타임 npm 감사 0건, 개발·빌드 의존성에는 중간 위험 14건이 남아 있습니다. 모든 취약점 부재나 모든 PC의 안전·정상 동작을 보장하지 않습니다.

다운로드 횟수는 GitHub의 해당 EXE asset 다운로드 이벤트이며 고유 사용자 수가 아닙니다. 검증을 위한 다운로드도 포함될 수 있습니다.

## 소스에서 빌드

Windows + Node.js 24 LTS 환경에서 순서대로 실행합니다. 일반 설치 이용자는 이 과정이 필요하지 않습니다.

```powershell
npm ci
npm --prefix experiments/siwc-8e ci
npm run build
npm run lint
npm run test
npm run release:v1
npm run release:verify:v1
```

공식 DevKit 원본과 고정 해시는 third_party/siwc-devkit 및 experiments/siwc-8e/source.json에 있습니다. 라이선스 고지와 원본은 그대로 보존했습니다. tests의 대화·비밀값은 합성 fixture입니다. SOURCE_INVENTORY.json은 현재 공개 소스 파일의 원본 SHA-256입니다. 기존 비공개 개발 Git 이력·인증·개인 기록·설치 파일은 소스 이력에 복사하지 않았습니다. 개인정보 상세: [docs/release/PRIVACY.md](./docs/release/PRIVACY.md), 사용자 안내: [docs/release/V1_USER_GUIDE.md](./docs/release/V1_USER_GUIDE.md).
