<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/drive/1UUWICtXMuC4zBJsxRMT7J8bdOcb4-U3X

## Run Locally

**Prerequisites:** Node.js

**API 서버 필수:** UI는 **YOLO_API_STUDIO**(또는 동일 API)가 떠 있어야 합니다. Vite에 내장된 `/api`는 사용하지 않습니다.

1. **먼저** `YOLO_API_STUDIO` 실행 (기본 포트 3001, `datasets.db`·`datasets` 경로 맞출 것).
2. 이 프로젝트에서 `npm install`
3. (선택) `.env.local`에 `GEMINI_API_KEY` 등
4. `npm run dev`  
   - `VITE_API_BASE_URL`을 안 넣으면 개발 시 **접속한 호스트와 같은 IP/호스트명** + 포트 `3001`로 API에 붙습니다 (예: `http://192.168.0.5:5174`로 열면 API는 `http://192.168.0.5:3001`). 다른 PC에서 로그인할 때 필요합니다.  
   - API만 다른 서버면 `.env.local`에 `VITE_API_BASE_URL=http://그서버:3001` 고정.

### 운영 빌드

`npm run build` **전에** 반드시 `VITE_API_BASE_URL`을 브라우저가 접속할 공개 API URL로 설정하세요. 없으면 빌드 결과가 기동 시 에러를 냅니다.
