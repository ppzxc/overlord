import { describe, expect, it } from "vitest";
import { goraebulAdapter } from "../src/adapters/goraebul.js";
import { defaultFacility, resolveFacility } from "../src/facility.js";
import { FakeClock, fakeHttp } from "./harness.js";

// 2026-11-16 웰빙문화테마마을·바다숲향기마을 화면에서 줄여 온 마크업. 고래불과 같은 엔진이고 주소 접두어만 다르다.
const day = (n: number, prefix: string, nav: string, zone: string, label: string, remaining: number) =>
  `<td ><span class='day'>${n}</span><ul class='list'><li><a href='${prefix}/pages/sub.htm?nav_code=${nav}&mode=step01&type=${zone}&today=2026-11-${n}&col=1' class='point_blue'>${label}</a><em>(${remaining})</em></li></ul></td>`;
const calendar = (prefix: string, nav: string, zone: string, label: string) =>
  `<table class="t_calendar"><tbody>${Array.from({ length: 30 }, (_, i) => day(i + 1, prefix, nav, zone, label, i + 1 === 20 ? 2 : 0)).join("")}</tbody></table>`;
const layout = (zone: string) =>
  `<div id="zone_${zone.toLowerCase()}" class="select_room"><a href="#" onclick="zone_area_select('2','${zone.toLowerCase()}_2','바다너울');return false;" id="${zone.toLowerCase()}_2" class="num "><span>2</span></a><a href="#" id="${zone.toLowerCase()}_1" class="num ban"><span>X</span></a></div>`;

const ctxFor = (seen: string[], prefix: string, nav: string, zone: string, label: string) => ({
  clock: new FakeClock(),
  http: fakeHttp(async (url) => {
    seen.push(url);
    return { status: 200, body: url.includes("view_cate=") ? calendar(prefix, nav, zone, label) : layout(zone) };
  }),
});

describe("영덕 통합예약의 시설별 주소", () => {
  const cases = [
    { facility: "wellbeing", prefix: "/wellbeing", nav: "wel1541599465", zone: "HTA", label: "펜션형 4인용" },
    { facility: "village", prefix: "/village", nav: "pa21524120539", zone: "VAA", label: "8인실" },
    { facility: "goraebul", prefix: "", nav: "gor1501675800", zone: "DKA", label: "숲속야영장A" },
  ];

  it.each(cases)("$facility: 캘린더와 자리 조회가 그 시설의 경로로 나간다", async ({ facility, prefix, nav, zone, label }) => {
    const seen: string[] = [];
    const open = { facility, zone, checkIn: "2026-11-20", nights: 1 };
    const closed = { facility, zone, checkIn: "2026-11-21", nights: 1 };
    const res = await goraebulAdapter.queryAvailabilityBatch!([open, closed], ctxFor(seen, prefix, nav, zone, label));
    expect(seen).toEqual([
      `https://stay.yd.go.kr${prefix}/pages/sub.htm?nav_code=${nav}&view_cate=2026&view_cate2=11`,
      `https://stay.yd.go.kr${prefix}/pages/zoneAreaAjax.htm?res_Day=2026-11-20&room_Code=${zone}&site_date=1`,
    ]);
    expect(res.get(open)).toHaveLength(1);
    expect(res.get(closed)).toEqual([]);
  });

  it.each(cases)("$facility: 딥링크가 그 시설의 예약 화면이다", ({ facility, prefix, nav, zone }) => {
    const link = goraebulAdapter.deepLink!({ facility, zone, checkIn: "2026-11-20", nights: 1 });
    expect(link).toBe(`https://stay.yd.go.kr${prefix}/pages/sub.htm?nav_code=${nav}&mode=step01&type=${zone}&today=2026-11-20&col=5`);
  });

  it("한 번의 배치에 두 시설이 섞여도 시설마다 캘린더를 따로 읽는다", async () => {
    const seen: string[] = [];
    const ctx = {
      clock: new FakeClock(),
      http: fakeHttp(async (url) => {
        seen.push(url);
        if (!url.includes("view_cate=")) return { status: 200, body: layout(new URL(url).searchParams.get("room_Code")!) };
        return { status: 200, body: url.includes("/wellbeing/") ? calendar("/wellbeing", "wel1541599465", "HTA", "펜션형 4인용") : calendar("/village", "pa21524120539", "VAA", "8인실") };
      }),
    };
    const w = { facility: "wellbeing", zone: "HTA", checkIn: "2026-11-20", nights: 1 };
    const v = { facility: "village", zone: "VAA", checkIn: "2026-11-20", nights: 1 };
    const res = await goraebulAdapter.queryAvailabilityBatch!([w, v], ctx);
    expect(seen.filter((u) => u.includes("view_cate="))).toHaveLength(2);
    expect(res.get(w)).toHaveLength(1);
    expect(res.get(v)).toHaveLength(1);
  });

  it("알 수 없는 시설은 다른 시설로 바꾸지 않고 unrecognized로 실패한다", async () => {
    const unit = { facility: "nowhere", zone: "HTA", checkIn: "2026-11-20", nights: 1 };
    const res = await goraebulAdapter.queryAvailabilityBatch!([unit], ctxFor([], "", "x", "HTA", "x"));
    expect(res.get(unit)).toMatchObject({ kind: "unrecognized" });
  });
});

describe("영덕 통합예약 카탈로그", () => {
  const info = goraebulAdapter.describe();

  it("시설을 안 고른 설정은 기존처럼 고래불이다", () => {
    expect(defaultFacility(info)?.code).toBe("goraebul");
    expect(resolveFacility(info).code).toBe("goraebul");
  });

  it("세 시설이 있고 바다숲향기마을은 1박만이다", () => {
    expect(info.facilities.map((f) => f.code)).toEqual(["goraebul", "wellbeing", "village"]);
    expect(resolveFacility(info, "village").maxNights).toBe(1);
    expect(resolveFacility(info, "wellbeing").maxNights).toBeUndefined();
  });

  it("구역 코드와 자리 id가 시설 안에서 겹치지 않는다", () => {
    for (const f of info.facilities) {
      const seats = f.zones.flatMap((z) => z.seats ?? []);
      expect(new Set(seats).size).toBe(seats.length);
      expect(new Set(f.zones.map((z) => z.code)).size).toBe(f.zones.length);
    }
  });
});
