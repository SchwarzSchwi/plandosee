# T07 제출문 — 구현 결과와 미확정 사항

> **실제 운영 배포·운영 SQL 실행·기존 개인 자료 이관·실제 5일 관찰은 미완료/미검증입니다.**
> 아래 로컬 테스트는 격리된 가상 fixture이며 실측 증거가 아닙니다.
> 사용자의 판단이나 활동을 AI가 대신 했다고 작성하지 않았습니다.

## ① 무엇으로 붙였나

**직접 구현한 서버 인증/세션 + 검증된 플랫폼 암호 구현**입니다. Supabase Auth 서비스를 사용한 구현이 아닙니다.

| 구분 | 실제 선택 |
|---|---|
| 플랫폼 | `.nvmrc`에 Node.js **22.23.3** 고정, 작업 환경에서 `v22.23.3`, 내장 OpenSSL **3.5.8** 확인. Vercel은 `engines.node=22.x`로 계열을 지정하며 운영 patch 버전은 별도 확인 필요 |
| DB 클라이언트 | `@supabase/supabase-js` **2.118.0**, `package-lock.json`에 전이 버전 고정 |
| 개발 도구 | Vercel CLI **48.12.1**; 운영 서비스의 내부 버전과는 별개 |
| 비밀번호 | `node:crypto.scrypt`(OpenSSL 구현), **N=32768, r=8, p=3, maxmem=64MiB**, 계정별 무작위 16바이트 salt, 64바이트 결과. 알고리즘/비용/salt/hash를 DB에 저장 |
| 인증 연결 | 직접 작성한 `server/auth.js`, `server/handler.js`와 DB RPC |
| 로그인 후 식별 | 무작위 32바이트 **서버 세션**; JWT 만료만 의존하지 않음 |
| 저장·전달 | DB에는 토큰 SHA-256 digest만, 브라우저에는 HttpOnly/SameSite=Strict 쿠키, 운영 Secure. URL/localStorage 사용 안 함 |
| 만료·폐기 | 발급 후 **8시간**, 슬라이딩 연장 없음. 로그아웃/비밀번호 변경은 해당 계정의 **모든 세션** 폐기 |

서버 키는 배포 환경변수 전용입니다. 세션은 서명 JWT가 아니므로 별도 JWT 서명키가 없으며, 무작위 토큰 자체가 비밀입니다.
클라이언트가 보낸 user_id/owner_id를 신원으로 사용하지 않습니다.

참고한 공식 문서:
- [Node crypto scrypt](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback)
- [Node crypto randomBytes](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptorandombytessize-callback)
- [Supabase service key와 RLS](https://supabase.com/docs/guides/database/postgres/row-level-security#bypassing-row-level-security)
- [OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [확인한 OWASP 공식 소스](https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Password_Storage_Cheat_Sheet.md): 문서 도메인 DNS 조회 실패로 GitHub 원문에서 N=2^15/r=8/p=3 조합 확인

문서는 암호 라이브러리/플랫폼의 사용 근거이며 운영 배포 버전의 검증 증거는 아닙니다. 배포 후 Node/OpenSSL 실제 버전을 관리자만 확인해야 합니다.

## ② 왜 그걸 골랐나

기존 Supabase PostgreSQL/Vercel 구조를 유지하면서, 각 요청이 DB에서 세션 폐기를 재검사하도록 구성했습니다.
scrypt는 널리 사용되는 플랫폼 구현이고 메모리 비용을 주어 오프라인 비밀번호 대입 비용을 높일 수 있어 선택했습니다. OWASP의 scrypt 조합 중 N=32768/r=8/p=3을 사용합니다.
독자 해싱 알고리즘은 만들지 않았지만 계정·세션·쿠키 연결 코드는 직접 구현했으므로 별도 검토가 필요합니다.

비교한 대안:
- **Supabase Auth:** 이메일 인증/복구/제한 등의 장점이 있지만 JWT 자체의 만료만으로는 요구한 즉시 폐기를 만족하지 못합니다. 별도 서버 폐기 검증을 붙이는 대신 이번에는 DB 세션 저장소를 명시적으로 구현했습니다. 서비스가 보안상 열등하다는 뜻은 아닙니다.
- **Argon2id 외부 패키지:** 좋은 선택이나 네이티브 배포 의존성 추가 대신 Node에 포함된 scrypt를 사용했습니다.
- **브라우저 localStorage JWT:** XSS 노출면과 즉시 폐기 요건 때문에 선택하지 않았습니다.

## ③ 어디를 어떻게 고쳤나

| 흐름 | 소스·DB 경로 |
|---|---|
| 가입 | `public/app.js` 인증 폼 → `server/handler.js:createHandler` signup → `server/auth.js:normalizeEmail,validPassword,hashPassword` → `auth_accounts` 정규화 이메일 UNIQUE |
| 로그인 | 인증 폼 → login → `verifyPassword` → 서버 무작위 세션 발급 RPC → 안전한 쿠키. 없는 계정도 dummy scrypt 수행, 없는 계정/틀린 비밀번호 동일 응답 |
| 로그아웃 | logout → 검증된 계정 잠금/모든 세션 삭제 → 쿠키 만료. 비밀번호 변경도 현재 비밀번호 재확인 후 원자적 교체/전체 폐기 |
| 자료 조회 | 인증 후 export/GET → `authorized_request`에서 유효한 세션 확인 → owner scope → JSON 응답. GET id를 실제 적용하며 타인/없는 ID는 404 |
| 관찰 | `public/model.js` 계산, `public/app.js` 관찰 폼 → `observation_request` → DB가 서울 날짜/순서/규칙변경 참조 강제 |
| 삭제 | 비밀번호 재확인 → 계정/자료/이력/관찰/세션 삭제. 내보내기에는 인증 테이블 제외 |

`supabase/migrations/002_t07_security.sql`의 인증 테이블은 브라우저 DB 역할에 공개하지 않습니다.
SECURITY DEFINER RPC도 public/anon/authenticated 실행권을 제거하고 service_role만 허용합니다.
service-role의 RLS 우회를 고려해 RPC 내부에서도 세션·소유권을 확인합니다. 복합 parent/owner 제약으로 타인 plan/task 연결을 방지하고 트리거 이력에도 소유권을 전달합니다.
기존 완료 이벤트 UNIQUE, 계획 스냅샷, 이월 트랜잭션, export 동일 스냅샷을 유지합니다.
원문 DB 오류·요청 본문·비밀번호·쿠키·Authorization을 서버 로그에 남기지 않습니다.

소스 바로가기: [요청 handler](../server/handler.js), [암호·쿠키](../server/auth.js),
[소유권·세션 SQL](../supabase/migrations/002_t07_security.sql),
[관찰 SQL](../supabase/migrations/003_t07_observations.sql),
[관리자 이관](../supabase/transfer.sql), [브라우저 UI](../public/app.js),
[실제 HTTP/DB 검증](../test/t07-integration.test.js), [관찰·수동 계산 검증](../test/observation.test.js).

### T06 기준본과 이력

작업 시작 코드 기준: `5b5a2672a1925c9eb7679b707faed56c50681c3c`.
조사 가능한 T06 PR #1 merge: `99934e0d3bd1b983dbdac1db4aa3c0598a99428a`,
구현: `902e4cff22a953559061d28c0511e45e966d94ca`,
후속 로깅 변경: `4cc38cc3cdaf7736f9d2942f706e35408c7b41ab`.
**실제 최종 T06 제출 커밋은 제공되지 않아 미확정입니다. merge commit을 최종 제출본이라고 단정하지 않습니다.**

작업 중 shallow 이력을 확장했고 아래 두 명령 모두 exit 0을 확인했습니다:
```sh
git merge-base --is-ancestor 99934e0d3bd1b983dbdac1db4aa3c0598a99428a HEAD
git merge-base --is-ancestor 902e4cff22a953559061d28c0511e45e966d94ca HEAD
```
사용자는 실제 제출 커밋을 확인하여 같은 명령으로 재검증해야 합니다. 과거 이력 수정·강제 푸시는 하지 않았습니다.

### SQL 적용·백업·자료 이관

1. 운영을 유지보수 모드로 전환하고 DB 제공자의 백업을 생성합니다. 로컬 덤프를 쓸 경우 안전한 관리자 환경의 `PGSERVICE`/비공개 pgpass를 사용하고 덤프·접속 문자열을 Git/제출물에 넣지 않습니다.
   ```sh
   umask 077
   pg_dump --format=custom --file=/tmp/plandosee-before-t07.dump
   ```
   이 예는 운영 DB가 아닌 현재 PG 연결 대상을 사용합니다. **대상 확인 후** 실행하고 안전한 보관소로 옮깁니다.
2. 새 설치는 `schema.sql` 후 `002`, `003`; 기존 완성된 T06 DB는 `002`, `003`만 순서대로 적용합니다. T06 이전 DB만 `001`을 먼저 적용합니다. Supabase SQL editor에서 각 파일 전체를 실행하거나, 관리자 PG 환경에서:
   ```sh
   psql -X -v ON_ERROR_STOP=1 -f supabase/migrations/002_t07_security.sql
   psql -X -v ON_ERROR_STOP=1 -f supabase/migrations/003_t07_observations.sql
   ```
   성공한 파일의 재실행은 지원하지 않으며 중복 객체에서 중단됩니다. 실패한 트랜잭션은 rollback 후 원인을 해결하여 다시 적용합니다. 적용 완료 파일을 별도 배포 기록에 적으세요. 새 설치에서 schema와 001을 함께 적용하지 마세요.
3. 정상 가입한 계정의 이메일/계정 UUID를 **관리자가 별도 경로로 실제 사용자와 대조**합니다. 이메일 소유권 자동 인증 서비스는 없으므로 단순 가입만으로 소유권을 입증했다고 보지 않습니다.
4. `supabase/transfer.sql`의 기본 차단용 대상 UUID를 검증된 UUID로 명시 변경하여 관리자만 실행합니다. 전체 무소유 T06 자료가 같은 사람의 자료인지 먼저 검토하세요. 서로 다른 사람의 자료가 섞였다면 실행하지 말고 별도 행별 이관 설계를 검토해야 합니다. 첫 가입자 자동 승계/API 공개 경로는 없습니다.
5. 이관 전후 row count, orphan/cross-owner 점검을 확인하고 UUID/parent-child/스냅샷 보존을 검증합니다. 실패하면 전체 rollback 후 조사합니다. 운영 이관은 아직 실행하지 않았습니다.
6. 세션 만료·소유권·내보내기·계정 삭제를 별도 테스트 계정으로 확인한 뒤 운영을 엽니다. 문제가 있으면 앱을 닫고 검증된 백업을 **별도 복구 DB**에 복원하여 확인하세요. 기존 DB를 즉시 덮어쓰는 복구는 피합니다.

### 운영 배포 (사용자 실행 필요)

신뢰된 로컬 checkout에서 `npm ci` 후 아래 명령을 사용합니다. 값은 대화형 입력으로만 등록하고 명령줄 인자/셸 이력/PR에 키 원문을 쓰지 마세요.
```sh
npm exec -- vercel env add SUPABASE_URL production
npm exec -- vercel env add SUPABASE_SECRET_KEY production
npm exec -- vercel env add APP_ORIGIN production
npm exec -- vercel --prod
```
이미 `SUPABASE_SERVICE_ROLE_KEY`를 쓰는 경우 중복 키 대신 그 서버 환경변수를 유지할 수 있습니다.
`APP_ORIGIN`은 `https://plandosee-six.vercel.app` 등 **실제 배포 origin과 정확히 일치**해야 합니다. 다른 도메인/preview를 쓰면 환경을 별도로 맞춥니다. 배포 프로젝트의 Node 22.x를 확인하고 관리형 런타임 patch 차이도 기록합니다.
심사 URL의 플랫폼 Deployment Protection/초대/CAPTCHA가 로그인 랜딩까지 막고 있지 않은지 직접 확인해야 합니다. 이를 공개로 설정해도 개인 기록은 앱 인증 뒤에만 있어야 합니다.
HTTPS, Set-Cookie의 Secure/HttpOnly/SameSite, 응답 no-store, DB RPC 권한, 요청 body를 수집하지 않는 로그 설정, 플랫폼 rate limit을 확인하세요.
**이 명령을 여기서 실행하거나 운영 배포 성공을 확인하지 않았습니다.**

## ④ 안 열리는 것을 확인한 기록

### 증거 구분과 재현

비밀번호는 테스트에서도 런타임 난수로 만들고 로그에 남기지 않습니다. 요청의 비밀값은 모두 `[REDACTED]`로 표시합니다. 동일 쿠키 재사용 여부는 공개 지문 대신 도구 내부 equality assertion으로 확인합니다.
소스 위치: `test/api.test.js`, `test/t07-integration.test.js`, `test/observation.test.js`, `test/database.sh`, `test/database.sql`.
**실행 결과는 아래 “실제 실행 결과”에만 기입하며, 다음 표는 검증 계약입니다.**

| 다섯 범주 | 성공 요청 ↔ 거절 요청 (비밀값 생략) | 통과 조건 |
|---|---|---|
| 1. 무인증/인증 | 로그인 후 GET `/api?action=export` ↔ 쿠키 없이 같은 GET | 200 ↔ 401; 첫 화면은 로그인, 사전 자료 네트워크 없음 |
| 2. 양방향 읽기 | A의 GET 내 plan ↔ 같은 A 쿠키로 B plan; B→A 반복 | 200 ↔ 404; 목록/export 타인 행 0 |
| 3. 양방향 수정 | A의 PATCH 내 plan ↔ B plan; B→A 반복 | 200 ↔ 404; 전후 상대 행 전체 내용/건수 동일 |
| 4. 양방향 삭제·연결 | A의 DELETE 내 task ↔ B task; B→A 반복, 타인 parent 생성/이월 | 성공 ↔ 404; 상대 내용/건수 동일, 새 행 없음 |
| 5. 세션 폐기 | GET `/api?table=plans`, Cookie `[REDACTED]` ↔ logout 후 **같은 METHOD+URL+쿠키** | 200 ↔ 401; 비밀번호 변경/만료/다른 세션도 거절 |

추가 계약: 동시 중복 가입 UNIQUE, 같은 비밀번호 계정들의 다른 저장 hash, 오류 계정/비밀번호 동일 안내,
query/header의 타인 ID 무시 후 내 자료만·body 주입 거절, 원문 로그/응답 비노출, DB 직접 접근 거절, 계정 삭제 cascade.
실제 비밀번호가 HTTPS 요청 body로 서버에 전송되는 것과 증거/로그에 영구 기록하는 것은 다릅니다.
**DevTools 요청 body에서 원문이 절대 안 보인다고 주장하지 않습니다.** HAR를 제출하지 말고 필요한 상태·경로만 가려 기록하세요.

### 실제 실행 결과

- Node `v22.23.3`, OpenSSL `3.5.8`를 명령으로 확인했습니다.
- `node --test test/security-audit.test.js`: 1 passed, 0 failed.
- `node scripts/security-audit.js`: 초기 검사 53개 대상, findings 0, shallow false. 최종 검사 결과는 아래 추가 기록을 참고하세요.
- `npm audit --omit=dev --audit-level=moderate`: 취약점 0.
- 전체 개발 의존성 감사: Vercel CLI 전이 의존성 경고가 남음(29건 보고). 최신 CLI도 경고가 있어 무관한 메이저 전환을 유지하지 않았습니다.
- 비밀 검사 확대 중 테스트의 고정 예제 비밀번호를 탐지했습니다(운영 계정/키 아님). 모두 런타임 난수로 교체했고 이후 API 테스트 14/14가 통과했습니다. 커밋 전 최종 패턴 검사: **63개 대상, findings 0, shallow false**. 저장소에 DB 임시 산출물이 남지 않음을 확인했습니다.
- 작성 담당 에이전트가 실행한 `node --test test/api.test.js test/auth-database.test.js`: **14/14 통과**. 실제 PostgreSQL 16의 세션 폐기 경합·소유권·이관·관찰 cascade 포함.
- 작성 담당 에이전트가 실행한 `node --test test/model.test.js test/observation.test.js`: **10/10 통과**. 관찰 단독 DB 테스트는 세션 resolver 모의이며, 아래 통합 테스트는 실제 인증 RPC를 사용합니다.
- `npm test`: 실행 기록 **27개 중 26 통과, 1 의도된 skip, 실패 0**. skip은 `T07_PG=1`이 필요한 독립 HTTP 통합 테스트이며 별도 명령에서 실제 실행했습니다.
- `npm run test:integration` / `bash test/t07-integration.sh`: 실제 격리 PostgreSQL + Node HTTP **1/1 통과**, 별도 SQL assertion 통과. 운영 Supabase HTTP 전송 대신 테스트용 psql adapter로 **실제 service_role SQL**을 호출하며 인증을 우회하지 않습니다.
- 로컬 브라우저는 **모의 HTTP 응답**으로 `/`, `/diary`, `/diary/private-test` 최초 session 요청만, 실패 로그인 시 비밀번호 지움/포커스, 로그인 후 export/study, 로그아웃/비밀번호 변경/탈퇴 후 로그인 화면, 텍스트 기반 XSS 비실행을 확인했습니다. 브라우저→운영 DB 통합 테스트는 아닙니다.
- 실제 Supabase/Vercel 인증정보가 없어 운영 DB/배포의 성공 응답은 아직 수집하지 않았습니다.

실제 격리 DB에서 읽은 한 계정의 저장 형식(검증기 전체 공개를 피하기 위해 salt/파생값은 가림):
```text
scrypt$32768$8$3$[salt REDACTED]$[derived REDACTED]
length=178
same-runtime-secret-hashes=DIFFERENT
distinct-salts=PASS independent-verification=PASS
```
두 계정에 같은 런타임 난수 비밀번호로 가입하여 실제 DB 저장 hash와 salt가 다름을 assertion으로 확인하고, 플랫폼 scrypt로 독립 재계산했습니다. 비밀번호 원문이나 완전한 verifier를 제출하지 않습니다. 이 계정들은 종료 시 삭제되는 격리 테스트 계정입니다.

실제로 통과한 HTTP 요청/응답 대조(각 쿠키/비밀번호 `[REDACTED]`, 실제 ID 대신 A/B로 표시):

| 검증 | 성공 응답 | 거절/격리 응답 | 변경 확인 |
|---|---|---|---|
| 무인증 | 로그인 후 GET `/api?action=export` → 200 | 쿠키 없이 같은 GET → 401 | 자료 응답 없음 |
| A→B 읽기 | A GET 본인 table/id → 200 | A GET B table/id → 404 | plans/tasks/versions/logs/reviews 전체 검사 |
| B→A 읽기 | B GET 본인 table/id → 200 | B GET A table/id → 404 | 거절별 상대 JSON 불변 |
| 양방향 수정 | PATCH 본인 plan → 200 | PATCH 타인 plan/task → 404 | 거절별 상대 JSON/건수 불변 |
| 양방향 삭제 | DELETE 본인 task → 200 | DELETE 타인 task → 404 | 새로운 자료 없음 |
| parent 참조 | POST 본인 task → 200 | 타인 plan/task 생성·변경·이월 → 404 | 상대 JSON 불변 |
| 신원 주입 | query/header 타인 ID 포함 GET → 200, 내 행만 | body owner_id/user_id → 400 | export/list에도 타인 행 0 |
| 로그아웃 | GET `/api?table=plans` + 같은 Cookie → 200 | logout 후 같은 GET·Cookie → 401 | 내부 동등성 assertion, 공개 지문 없음 |
| 비밀번호·만료 | password 변경 → 200, 새 비밀번호 login → 200 | 모든 옛 세션/옛 비밀번호/만료 세션 → 401 | 세션 저장소의 폐기 확인 |
| 로그인 오류 | 올바른 login → 200 | 없는 계정/틀린 런타임 난수 비밀번호 → 401/401, 정확히 같은 body | 실제 HTTP/DB, 원문 로그 비노출 |
| 가입 중복 | 동시 signup 모두 일반 응답 200 | 같은 이메일 DB 행 추가 없음 | 서로 다른 이메일 2계정, salt/hash 다름 |
| 관찰 | create-study/observe → 200 | 당일 중복·날짜 주입·성급한 규칙 변경 → 400, 타인 observe/change → 404 | 매 거절 앞뒤 상대 JSON 불변 |
| 탈퇴 | 비밀번호 확인 후 delete-account → 200 | 같은 쿠키 GET 200→401, 별도 세션도 401 | 실제 SQL 계정/세션/소유 자료 각각 0행 |

위 내용은 로컬 fixture 실행 결과입니다. 실제 배포에서 다시 수행해야 합니다.
**재검증 범위 주의:** 전체 26 통과 기록은 임시 DB 디렉터리가 프로젝트 내부였던 실행의 기록입니다.
최종 파일은 임시 DB를 `/tmp`(관찰은 OS tmpdir)에 만들고 정리하도록 수정했으나, 이 경로 정리 뒤 전체/독립 DB 테스트는 이 세션에서 다시 실행하지 않았습니다.
비밀번호 fixture 난수화 뒤에는 API/인증 DB 14/14와 확장 HTTP 통합 테스트가 통과한 기록이 있습니다. 최종 checkout에서 위 재현 명령을 다시 실행해 이 경로 차이도 확인해야 합니다.

재현 명령(운영 비밀 불필요):
```sh
npm ci
npm test
npm run test:integration
npm run audit:secrets
npm audit --omit=dev --audit-level=moderate
```
PostgreSQL 서버 도구와 non-root 사용자가 필요합니다. 없는 환경에서는 DB 검증 skip을 성공으로 세지 마세요. CI에서도 운영 키를 주입하지 말고 로컬 임시 DB를 쓰세요. 테스트 임시 파일은 `/tmp`에 생성·정리합니다.

## ⑤ AI와 나

- **AI에게 맡긴 일:** 기존 소스 조사, 인증/DB 소유권/관찰 UI/SQL/자동 검증/이 제출문 초안 작성과 실제 가능한 로컬 검증.
- **사용자가 직접 판단한 것으로 확인된 일:** T07 기준 전체 적용과 기존 T06 이어쓰기 요청. 암호 방식 선택, 실측값, 운영 이관 대상, 최종 T06 제출 커밋에 대한 사용자 판단은 아직 확인되지 않았습니다. **사용자 직접 확인·작성 필요.**
- **AI 제안을 따르지 않은 일:** 이 작업 중 사용자가 어떤 제안을 거절했는지 확인된 기록이 없습니다. “모두 동의했다”는 뜻이 아닙니다. **사용자가 실제 경험을 확인하여 작성 필요.**

## ⑥ 아직 못 막은 것

1. 이메일 인증·비밀번호 복구·MFA·분산 로그인 rate limiting은 없습니다. 계정 선점/온라인 대입/해싱 자원 소모 위험이 있으므로 공개 운영 전 플랫폼 요청 제한과 이메일 소유권 확인 정책이 필요합니다. 가입된 이메일만으로 기존 T06 자료를 이관하면 안 됩니다.
2. service-role/DB 관리자 탈취는 앱의 owner scope로 막을 수 없습니다. 최소 권한·접근 통제·키 교체·비공개 백업이 필요합니다.
3. Vercel CLI 개발 전이 의존성의 알려진 취약점이 남습니다. 악성 프로젝트/아카이브 입력과 외부 공개 개발 서버가 위험합니다. 운영 API에는 CLI를 사용하지 않고 개발은 신뢰된 입력만 취급해야 합니다.
4. 서버는 실제 날짜/순서를 보장하지만 사용자가 입력한 분이 실제 관찰 사실인지는 증명하지 못합니다. 실제 5일의 활동 근거를 사용자가 직접 수집해야 합니다. 누락된 날은 0으로 꾸며 채우지 않습니다.
5. 앱/API 요청 본문을 수집하는 Vercel/프록시/외부 APM 설정은 여기서 확인하지 못했습니다. 운영 로그 본문 수집을 끄고 가려진 증거로 검증해야 합니다.
6. 세션 테이블의 만료 행 정리, DB 백업 보존기간·탈퇴 후 백업 잔존 정책, 대용량 export 한도는 운영 과제입니다. 계정 삭제는 현재 DB 삭제이지 과거 백업의 즉시 삭제를 뜻하지 않습니다.

## 실제 5일 관찰 규칙과 남은 수집

- 질문 한 문장: **실행 규칙을 바꾼 뒤 하루 실제 실행 시간(분)은 어떻게 달라지는가?**
- 지표 하나 `actual_minutes`, 단위 분, 하루 관찰 실제 실행시간을 정수 분으로 입력합니다. 0은 실제 0분 관찰, 미기록은 결측이며 0으로 대체하지 않습니다.
- 날짜: DB 서버가 `Asia/Seoul` 오늘을 부여, 생성시각은 별도 timestamptz. 하루 1개·순서대로 최대 5개. 연속일을 강요하지 않지만 서로 다른 실제 날짜 정확히 5일이 필요합니다. 과거/미래 timestamp 제출을 받지 않습니다.
- 중복: UNIQUE/서버 검증으로 거절. 이상치: 0~1440 밖/소수/잘못된 입력 거절, 범위 내 특이값은 임의 제거하지 않음. 정수 분의 실측 기준을 1일차에 고정하고 유지해야 합니다.
- 합계는 같은 다섯 분 값의 합, 평균은 합계/5를 소수 둘째 자리 반올림. 불완전 자료는 불완전으로 표시하고 실제 입력 건수로 계산된 부분 집계와 구분합니다. 주 시작 월요일.
- 2일차 저장 뒤 3일차 저장 전 규칙 변경 한 건: 정확한 day1/day2 UUID, 이유, 변경 규칙, 서버 생성시각을 보존. 지표·단위·계산은 바꾸지 않습니다.
- 자료 수집 전 현재 상태는 **실제 자료 필요**입니다. seed와 테스트 fixture를 실제 관찰이라고 제출하지 않습니다.

계산 재현용 **가상 fixture**(`test/observation.test.js`): 0+4+1+2+2 = **9분**, 평균 9/5 = **1.80분**.
변경 전 0+4 = 4분/2 = 2.00분, 변경 후 1+2+2 = 5분/3 = 1.67분입니다. 자동 assertion은 이 수동 값과 같은 계산 함수를 비교합니다.
이 수치는 사용자 실측값이 아니며, 본인의 다섯 날짜 자료가 모인 뒤 내보낸 JSON의 같은 다섯 값을 손으로 다시 대조해야 합니다.

## 짧은 확인 방법 (C39)

### ① 어디로 가나요
예정 결과물 [공개 로그인 랜딩](https://plandosee-six.vercel.app), [공개 소스](https://github.com/SchwarzSchwi/plandosee).
이 PR의 변경이 결과물 URL에 배포됐다는 뜻은 아닙니다. **새 시크릿의 최신 배포 접근은 미검증**입니다.
작업 환경의 익명 HTTP 조회에서 공개 GitHub 소스는 열렸으나 결과물 도메인은 DNS 조회 실패(`No address associated with hostname`)였습니다. 이는 시크릿 브라우저 접근 성공이나 사이트의 영구 장애를 입증하지 않습니다.
공개 URL은 로그인 화면/소스까지이며 로그인 뒤 내 기록은 공개 접근 대상이 아닙니다.

### ② 세 단계 안에 무엇을 하나요
1. 새 시크릿 창으로 열어 로그인 화면과 로그인 전 네트워크를 확인합니다.
2. 본인의 새 테스트 계정으로 가입·로그인하여 계획을 만들고 내보냅니다.
3. 로그아웃 후 자료 주소/동일 자격증명 재사용 요청이 거절되는지 안전한 테스트 도구로 확인합니다.

### ③ 무엇이 보이면 통과인가요
첫 화면 공개 로그인, 로그인 전 기록 없음, 로그인 후 내 자료만, 로그아웃 후 자료 GET 401.
양방향 타인자료/폐기/관찰은 위 자동 테스트와 별도 운영 확인까지 완료되어야 합니다.

### ④ 안 될 때는 무엇이 보이나요
설정 누락은 503/일반 오류, 다른 Origin은 403, 무세션은 401, 타인 ID는 404, 중복/잘못된 관찰 입력은 거절.
로그인 전 자료가 보이거나 로그아웃한 옛 쿠키로 200이면 실패이며 배포를 닫고 조사합니다.

## 전체 기준 추적표

상태는 **구현**(소스 존재), **검증됨**(명시된 로컬 실행), **실제 자료 필요**, **배포 확인 필요**를 구분합니다. 구현은 전체 통과를 뜻하지 않습니다.

| ID | 상태·근거/남은 확인 |
|---|---|
| C01 | 공개 소스 익명 HTTP 조회됨·랜딩/시크릿 배포 확인 필요 — 위 C39 |
| C03 | 구현·배포 확인 필요 — `public/index.html`, 로그인 gate |
| C04 | 구현 — studies 고정 질문, 003 |
| C05 | 구현 — actual_minutes 단일 지표, 003 |
| C06 | 구현 — minutes 단위, 003 |
| C07 | 실제 자료 필요 — 본인 계정 실제 서울 날짜 5개 |
| C08 | 구현·실제 자료 필요 — 고정 계산, model/003 |
| C09 | 구현·실제 자료 필요 — 2일 뒤/3일 전 DB gate |
| C10 | 구현·실제 자료 필요 — rule_changes.created_at |
| C11 | 구현·실제 자료 필요 — reason 필수 |
| C12 | 구현·실제 자료 필요 — day1/day2 복합 FK |
| C13 | 구현 — metric 불변 |
| C14 | 구현 — unit 불변 |
| C15 | 구현 — 동일 합계/평균 model |
| C23 | 구현 — 결측 제외/미완료 표시, 관찰 규칙 |
| C24 | 구현 — 날짜/일차 UNIQUE |
| C25 | 구현 — 0~1440 정수 제약 |
| C26 | 구현 — 평균 소수 2자리, model |
| C27 | 구현 — 월요일 규칙 |
| C39 | 작성 — 위 짧은 확인 방법 네 항목 |
| C40 | 사용자 확인 필요 — ⑤ 세 항목 |
| C46 | 로컬 패턴 검증됨·배포 확인 필요 — audit:secrets |
| C77 | 사용자 확인 필요 — 실제 최종 T06 제출 커밋 미확정 |
| C78 | 후보 커밋 ancestry 검증됨·최종 커밋 확인 필요 — ③ 명령 |
| C91 | 작성 — ① 직접 인증+플랫폼 암호 |
| C92 | 검증됨 — npm ls/Node/OpenSSL, ① 정확한 버전 |
| C93 | 작성 — ② Supabase Auth/Argon2id/JWT 대안 |
| C94 | 로컬 HTTP 검증됨·배포 확인 필요 — signup 폼/API |
| C95 | 로컬 HTTP 검증됨·배포 확인 필요 — login 폼/API |
| C96 | 로컬 HTTP 검증됨·배포 확인 필요 — logout/전체 폐기 |
| C97 | 모의 브라우저 검증됨·배포 확인 필요 — HTML 로그인 gate |
| C98 | 로컬 HTTP/DB 검증됨 — 정규화 이메일 UNIQUE/동시 가입 |
| C99 | 로컬 HTTP 검증됨 — 없는 계정/틀린 비밀번호 동일 status/body |
| C100 | 이관 SQL 구현·실제 자료 이관 필요 — transfer.sql |
| C101 | 작성 — scrypt, ① |
| C102 | 작성 — 메모리 비용/플랫폼 구현 선택 이유, ② |
| C103 | 격리 DB 검증됨 — ④ 실제 저장 형식 redaction/길이178 |
| C104 | 격리 DB 검증됨 — 런타임 난수 동일 비밀번호·서로 다른 salt/hash |
| C105 | 구현 — 증거 redaction·원문 request 보관 금지 |
| C106 | 구현·운영 로그 확인 필요 — generic errors/TLS 설명 |
| C107 | 작성 — 플랫폼 해싱/직접 세션 구현 구분 |
| C108 | 작성 — 서버 세션, ① |
| C109 | 로컬 HTTP 검증됨 — ④ 같은 GET 200/401 |
| C110 | 로컬 HTTP 검증됨 — 내부 쿠키 equality assertion |
| C111 | 로컬 HTTP/DB 검증됨 — 8시간 만료/만료 세션 거절 |
| C112 | 구현 — HttpOnly 쿠키, URL/localStorage 없음 |
| C113 | 로컬 패턴 검증됨·배포 확인 필요 — 서버 전용 키 |
| C114 | 로컬 HTTP/DB 검증됨 — 로그아웃/비밀번호 변경 모든 세션 폐기·경합 |
| C115 | 작성 — 증거의 비밀값 [REDACTED] |
| C116 | 격리 HTTP/DB 두 계정 생성 검증됨·운영은 미검증 |
| C117 | 로컬 HTTP 검증됨 — A→B 읽기 404 |
| C118 | 로컬 HTTP 검증됨 — A→B 수정 404 |
| C119 | 로컬 HTTP 검증됨 — A→B 삭제 404 |
| C120 | 로컬 HTTP 검증됨 — B→A 읽기/수정/삭제 |
| C121 | 구현 — 타인/없는 ID 404 |
| C122 | 로컬 HTTP 검증됨 — 각 거절 전후 내용/건수 동일 |
| C123 | 로컬 HTTP 검증됨 — query/header 무시·body owner 주입 거절 |
| C124 | 로컬 HTTP 검증됨 — 무인증 직접 요청 401 |
| C125 | 로컬 HTTP 검증됨 — 목록/export owner scope |
| C126 | 작성 — ③ 소스/함수/SQL 연결 |
| C127 | 작성 — 여섯 항목 분리 |
| C128 | 작성 — ③ 네 흐름 표 |
| C129 | 로컬 검증됨·운영 확인 필요 — ④ 다섯 범주·성공/거절 대조 |
| C130 | 작성 — ⑥ 구체적 위험/운영 한계 |
| C131 | 로컬 패턴 검증됨·운영 확인 필요 — 비밀값 마스킹 |
| C132 | 가상 계산 검증됨·실제 자료 필요 — model/관찰 테스트, 본인 5일 수동 대조 |
| C133 | 로컬 HTTP/DB 검증됨·배포 확인 필요 — 내 자료 JSON 하나, auth 제외 |
| C134 | 로컬 HTTP/DB 검증됨·배포 확인 필요 — 비밀번호 확인 후 계정/자료 삭제 |
