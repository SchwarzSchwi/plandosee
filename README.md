# 플랜두씨 다이어리

Supabase PostgreSQL + Vercel Serverless API + 정적 HTML/JavaScript.

1. Supabase SQL Editor에서 `supabase/schema.sql` 실행.
2. Vercel 프로젝트에 환경 변수 `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` 등록 (서버 전용, `VITE_` 접두어 금지).
3. GitHub에 프로젝트를 올려 Vercel 배포. 루트 디렉터리는 이 폴더로 설정.
4. 로컬에서는 `npm install` 후 `npx vercel dev` 실행.

**주의:** 로그인 없는 공개 앱입니다. URL을 아는 누구나 데이터에 접근하거나 변경할 수 있습니다. 실명, 비밀, 민감정보를 넣지 마세요. `service_role` 키는 브라우저에 노출되지 않지만 API는 공개되어 있습니다. 실제 운영에는 인증과 권한 검사, rate limiting을 추가해야 합니다.

**테스트 한계:** 실제 Supabase 연결 및 T06 전체 자동 검증은 수행하지 않았습니다. 동시 완료 요청에 대한 DB 원자성 보장, 샘플 데이터 조건(T06-C78~81)은 추가 작업이 필요합니다.
