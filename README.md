# 친구 결과 예측판 (실시간, 여러 폰 함께)

떨어져 있는 친구들이 각자 폰으로 접속해, 자기 차례에 자기 이름으로 표의 빈칸을 채우는 웹앱입니다.
- 순서 강제: 자기 차례에만 자기 폰에서 빈칸 선택 가능
- 각자 자기 이름(색)으로 채움
- 방장(비밀번호)만 표(제목·칸·행/열) 편집·진행 제어

## 배포 (GitHub → Render → Turso)
1. Turso DB 준비 → URL·토큰 (기존 judging DB 재사용 가능: board_claims/board: 키로 분리됨)
2. GitHub 새 저장소에 이 폴더 업로드 (.env 제외)
3. Render → New Web Service → Runtime Node, Build `npm install`, Start `npm start`
   - 환경변수: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN, ADMIN_PIN
4. 배포 주소 → 하단 "방장 화면" → PIN(기본 1234) → 표 만들기 → QR/링크를 친구에게 전송

## 사용
- 방장: 표 편집(여러 판·복제·순서이동), "한 번에 N칸", 참가자 순서 정리 후 "▶ 시작"
- 친구: 링크 접속 → 이름 입력 → 참여 → 자기 차례에 빈칸 탭(자기 이름으로 채워짐)
- 모두 채워지면 완성. 되돌리기/이 판 비우기/전체 초기화는 방장만.
