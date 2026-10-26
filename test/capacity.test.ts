import { describe, expect, it } from "vitest";
import { renderOpenings, type OpeningEntry } from "../src/telegram.js";
import type { ProviderInfo } from "../src/types.js";
import { configWith, settle, startPoller } from "./harness.js";
import { FOREST_ENV, foresttripServer } from "./foresttrip-server.js";

const info = {
  id: "x",
  facilities: [
    {
      code: "f",
      name: "시설",
      zones: [
        { code: "A", name: "오토캠핑", type: "오토캠핑", capacity: 4 },
        { code: "B", name: "카라반 6인실", type: "카라반", capacity: 6 },
        { code: "C", name: "숲속의집", type: "숲속의집" },
      ],
    },
  ],
} as unknown as ProviderInfo;

const entry = (zone: string, sites: OpeningEntry["sites"]): OpeningEntry => ({
  watchName: "감시",
  query: { facility: "f", zone, checkIn: "2026-11-07", nights: 1 },
  sites,
  link: "https://example.test",
});
const textOf = (e: OpeningEntry) => renderOpenings({ chatId: "1", info, entries: [e] })[0]!.message.text;

describe("알림의 허용 인원 표기", () => {
  it("자리 이름 옆에 자리의 인원을 괄호로 적는다", () => {
    expect(textOf(entry("C", [{ id: "a", name: "잣나무1호", capacity: 2 }, { id: "b", name: "금강송", capacity: 8 }]))).toContain("잣나무1호(2인), 금강송(8인)");
  });

  it("자리의 인원이 없으면 구역의 인원을 적는다", () => {
    expect(textOf(entry("A", [{ id: "A1", name: "A1" }]))).toContain("A1(4인)");
  });

  it("자리의 인원이 구역의 인원보다 우선한다", () => {
    expect(textOf(entry("A", [{ id: "A1", name: "A1", capacity: 6 }]))).toContain("A1(6인)");
  });

  it("13인승 같은 이름은 인원으로 보지 않는다", () => {
    expect(textOf(entry("A", [{ id: "A1", name: "13인승 버스" }]))).toContain("13인승 버스(4인)");
  });

  it("인원을 모르면 괄호를 붙이지 않는다", () => {
    expect(textOf(entry("C", [{ id: "a", name: "잣나무1호" }]))).toContain("잣나무1호");
    expect(textOf(entry("C", [{ id: "a", name: "잣나무1호" }]))).not.toContain("인)");
  });

  it("이름에 이미 인원이 있으면 중복해서 붙이지 않는다", () => {
    const text = textOf(entry("B", [{ id: "a", name: "C01(4인)" }]));
    expect(text).toContain("C01(4인)");
    expect(text).not.toContain("(6인)");
  });

  it("남은 수만 아는 예약처는 구역 이름 옆에 인원을 적고, 이미 있으면 적지 않는다", () => {
    expect(textOf(entry("A", [{ id: "A", name: "A", remaining: 2 }]))).toContain("오토캠핑(4인) · 남은 2");
    expect(textOf(entry("B", [{ id: "B", name: "B", remaining: 1 }]))).toContain("카라반 6인실 · 남은 1");
  });
});

describe("숲나들e 알림의 허용 인원", () => {
  it("상품 목록의 최대 인원을 이름 옆에 적는다", async () => {
    const yaml = configWith(`
  - name: 유명산 감시
    provider: foresttrip
    facility: yumyeongsan
    zones: ["01002"]
    checkIn: { from: 2026-11-20, to: 2026-11-20 }
    nights: 1
    notify: [default]`);
    const server = foresttripServer({ status: (_g, date) => (date === "2026-11-20" ? { rsrvtAvail: "Y", rsrvtCnt: 0 } : { rsrvtAvail: "Y", rsrvtCnt: 1 }) });
    const p = startPoller(() => ({ status: 404, body: "" }), { yaml, server, env: FOREST_ENV, now: "2026-10-20T14:00:00+09:00" });
    await settle();
    expect(p.sent[0]!.text).toContain("고라니(6인)");
    await p.stop();
  });
});
