# Windows에서 GitHub Actions로 TestFlight 배포

Windows에서 Apple과 GitHub를 설정하면 GitHub의 macOS 러너가 iPhone용 앱을 빌드하고 서명합니다. `main`에 `app-store/` 또는 TestFlight 워크플로 변경을 푸시할 때마다 App Store Connect에 내부 테스트용 빌드를 업로드합니다. [TestFlight 워크플로](../../.github/workflows/app-store-testflight.yml)

## 1. Apple에 앱 등록

1. Apple Developer Program에 가입한 계정으로 Apple Developer의 **Certificates, Identifiers & Profiles → Identifiers**를 엽니다. Explicit App ID `com.sangminbis9.skinstudio`를 등록합니다. 이미 같은 ID가 내 팀에 있으면 재사용합니다. [App ID 등록](https://developer.apple.com/help/account/identifiers/register-an-app-id/)
2. App Store Connect의 **Apps → + → New App**에서 플랫폼을 iOS, 이름을 `마크 스킨 뚝딱 - 사진 한장으로 나만의 스킨 만들기`, 기본 언어를 한국어로 설정합니다. 위 Bundle ID를 선택하고 SKU는 `skin-studio-ios`처럼 계정 내에서 유일한 값으로 입력합니다. 이미 앱 레코드가 있으면 그 앱을 사용합니다. [앱 레코드 추가](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app/)

## 2. Windows에서 서명 파일 만들기

이미 사용할 수 있는 **Apple Distribution `.p12`** 파일과 암호가 있다면 해당 인증서를 재사용하고 프로파일을 생성합니다. 새 인증서가 필요하면 저장소 밖의 개인 폴더에서 아래 작업을 합니다. Apple Distribution 인증서와 App Store Connect 프로파일을 만들려면 팀의 Account Holder 또는 Admin 권한이 필요합니다. [인증서 권한](https://developer.apple.com/help/account/certificates/certificates-overview/) · [프로파일 생성](https://developer.apple.com/help/account/provisioning-profiles/create-an-app-store-provisioning-profile/)

1. Windows에서 Git Bash를 열고 `openssl version`으로 OpenSSL을 확인합니다. 아래 명령은 개인 키 암호를 묻고 Apple에 제출할 CSR을 만듭니다.

   ```sh
   MSYS_NO_PATHCONV=1 openssl req -new -newkey rsa:2048 -keyout distribution.key -out distribution.certSigningRequest -subj "/CN=Skin Studio Distribution"
   ```

2. Apple Developer의 **Certificates → + → Apple Distribution**에서 `distribution.certSigningRequest`를 업로드합니다. 발급된 인증서를 `distribution.cer`로 내려받아 같은 폴더에 둡니다. CSR에 쓴 개인 키와 짝이 맞는 인증서를 아래 명령으로 `.p12`에 담습니다. 첫 암호 입력은 기존 개인 키를 열기 위한 것이고, **Export Password**는 새 `.p12`의 암호입니다. [OpenSSL PKCS#12 명령 안내](https://docs.openssl.org/3.5/man1/openssl-pkcs12/)

   ```sh
   openssl x509 -inform DER -in distribution.cer -out distribution.pem
   openssl pkcs12 -export -inkey distribution.key -in distribution.pem -out distribution.p12 \
     -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1
   ```

3. **Profiles → + → Distribution → App Store Connect**를 선택합니다. `com.sangminbis9.skinstudio`와 위 `.p12`에 들어 있는 **같은 배포 인증서**를 선택합니다. 다운로드한 프로파일을 `skin-studio.mobileprovision`으로 저장합니다. [App Store Connect 프로파일 생성](https://developer.apple.com/help/account/provisioning-profiles/create-an-app-store-provisioning-profile/)

## 3. 업로드용 API 키 발급

App Store Connect의 **Users and Access → Integrations → App Store Connect API → Team Keys**에서 업로드용 키를 생성합니다. **Developer** 역할은 빌드 업로드 권한이 있습니다. 메뉴에 **Request Access**가 보이면 Account Holder가 먼저 API 접근을 요청해야 합니다. **Key ID**, **Issuer ID**, 내려받은 `AuthKey_<KEY_ID>.p8` 파일을 보관합니다. Apple은 개인 키 파일을 한 번만 내려받을 수 있게 합니다. [Team API 키 생성](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/) · [빌드 업로드 권한](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/)

## 4. GitHub에 Secrets 등록

저장소의 **Settings → Environments → testflight**를 엽니다. 환경이 없으면 이름을 `testflight`로 생성합니다. **Deployment branches and tags**에서 **Selected branches and tags**를 선택하고 Branch 규칙으로 `main`을 추가합니다. 자동 배포를 사용하려면 이 환경에 수동 승인 규칙을 추가하지 않습니다. 같은 화면의 **Environment secrets**에 아래 여섯 값을 등록합니다. [GitHub 환경 설정](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)

| Secret 이름 | 값 |
| --- | --- |
| `APPLE_DISTRIBUTION_P12_BASE64` | `distribution.p12`의 Base64 문자열 |
| `APPLE_DISTRIBUTION_P12_PASSWORD` | `.p12`를 만들 때 지정한 Export Password |
| `APPLE_PROVISIONING_PROFILE_BASE64` | `skin-studio.mobileprovision`의 Base64 문자열 |
| `APP_STORE_CONNECT_KEY_ID` | Team API 키의 Key ID |
| `APP_STORE_CONNECT_ISSUER_ID` | Team Keys 화면의 Issuer ID |
| `APP_STORE_CONNECT_PRIVATE_KEY` | `.p8` 파일 전체 원문. 시작·끝 줄과 줄바꿈 포함 |

파일이 있는 폴더에서 PowerShell로 아래 명령을 **한 줄씩** 실행하고, 각 결과를 해당 Secret에 붙여넣습니다. 마지막 줄의 파일 이름은 실제 키 이름으로 바꿉니다.

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes((Resolve-Path 'distribution.p12').Path)) | Set-Clipboard
[Convert]::ToBase64String([IO.File]::ReadAllBytes((Resolve-Path 'skin-studio.mobileprovision').Path)) | Set-Clipboard
Get-Content -Raw -LiteralPath 'AuthKey_<KEY_ID>.p8' | Set-Clipboard
```

서명 파일과 비밀 값은 저장소나 채팅에 올리지 않습니다. 워크플로가 프로파일에서 Apple Team ID를 읽으므로 Team ID를 별도로 입력할 필요는 없습니다. [GitHub의 Apple 서명 설정 안내](https://docs.github.com/en/actions/how-tos/deploy/deploy-to-third-party-platforms/sign-xcode-applications)

## 5. 첫 업로드와 iPhone 설치

1. GitHub **Actions → App Store TestFlight → Run workflow**에서 `main`을 선택해 첫 실행을 시작합니다. 이후에는 `main`에 앱 변경을 푸시하면 자동으로 시작합니다. 여섯 Secret이 모두 비어 있으면 서명 없는 iPhone용 Release 아카이브를 검증합니다. 일부만 등록하면 실행 로그에 누락된 이름을 표시합니다.
2. **Upload to App Store Connect for internal TestFlight** 단계가 성공하면 Apple의 빌드 처리가 끝나기를 기다립니다. 워크플로는 실행 번호와 재실행 횟수를 조합해 매 시도에 다른 빌드 번호를 사용합니다. [업로드 및 처리 안내](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds/)
3. App Store Connect의 앱에서 **TestFlight → Internal Testing** 그룹을 만들고 본인 계정과 첫 빌드를 추가합니다. **Enable automatic distribution**을 켜면 이후 빌드가 같은 그룹에 전달됩니다. iPhone에서 초대를 열고 TestFlight 앱으로 설치합니다. [내부 테스터 및 자동 배포 설정](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers/)

빌드에 **Missing Compliance**가 표시되면 TestFlight에서 Apple의 질문에 답한 뒤 그룹에 추가합니다. 이 워크플로의 빌드는 내부 테스터 그룹에서 사용합니다. 공개 출시에는 별도의 배포 빌드를 준비합니다. [베타 빌드 수출 규정 안내](https://developer.apple.com/help/app-store-connect/test-a-beta-version/provide-export-compliance-information-for-beta-builds/)

서명 단계에서 실패하면 프로파일의 만료일, App ID, 선택한 배포 인증서가 `.p12`와 일치하는지 확인합니다. 업로드 단계에서 인증 오류가 나면 Team API 키의 Key ID, Issuer ID, `.p8`가 서로 짝이 맞는지와 키 권한을 확인합니다.
