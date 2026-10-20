import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach } from "vitest";

// 숲나들e 로그인 실패 기록 파일을 테스트마다 새 임시 경로로 둔다. 실제 `data/`를 건드리지 않고 테스트끼리 기록이 새지 않는다.
beforeEach(() => {
  process.env.FORESTTRIP_LOGIN_STATE_FILE = join(mkdtempSync(join(tmpdir(), "foresttrip-login-")), "login-failure.json");
});
