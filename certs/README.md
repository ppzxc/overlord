# 신뢰 목록에 더하는 중간 인증서

서버가 중간 인증서를 보내지 않는 예약처에 TLS 검증을 끄지 않고 연결하려고, 공개된 중간 인증서를 Node 기본 루트에 더한다(`src/transport.ts`). 이 폴더의 `*.pem`은 모두 읽어 더한다. 실행 중에 인증서를 내려받지는 않는다.

## sectigo-public-server-authentication-ca-dv-r36.pem

| 항목 | 값 |
|---|---|
| 주체 | Sectigo Public Server Authentication CA DV R36 |
| 발급자 | Sectigo Public Server Authentication Root R46 (Node 내장 루트 목록에 있다) |
| 받은 곳 | http://crt.sectigo.com/SectigoPublicServerAuthenticationCADVR36.crt (Sectigo의 AIA `crt.sectigo.com`, DER를 PEM으로 바꿨다) |
| SHA-256 지문 | `8C:54:C3:34:B6:6B:A4:E4:26:77:2A:F4:A3:F9:13:6C:19:A1:AE:C7:29:FD:B2:8C:53:5C:07:A5:A4:EF:22:E0` |
| 유효 기간 | 2021-03-22 ~ 2036-03-21 23:59:59 GMT |
| 일련번호 | 397A66CC2756362E0DAA87CA6EABE3B1 |

필요한 호스트: `campwait.junggu.ulsan.kr`(울산 중구 대기열), `camping.ubimc.or.kr`(울산 북구). 두 서버는 말단 인증서만 보내고 이 중간 인증서를 보내지 않는다.

받은 뒤 확인한 것: 발급자가 Root R46이고, Node 22·24가 내장한 R46 루트로 `openssl verify`가 통과한다(http로 받았으므로 서명이 무결성의 근거다). `test/transport.test.ts`가 지문·만료일·R46 서명을 다시 본다.

## 바꿀 때

인증서가 만료되기 전에(2036-03) 또는 예약처가 다른 중간 인증서로 바꾸면 새 PEM을 이 폴더에 더하고 이 표에 같은 항목을 적는다. 받은 파일이 기대한 주체·발급자인지, 내장 루트로 `openssl verify`가 통과하는지 확인한 뒤 둔다.
