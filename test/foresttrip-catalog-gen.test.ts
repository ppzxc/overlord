import { describe, expect, it } from "vitest";
import { assertPublicRead, assignSlugs, buildFacilities, parseMapFacilities, parseZones, PoliteFetcher, renderCatalogSource, slugify } from "../src/tools/foresttrip-catalog.js";
import { facilities } from "../src/catalogs/foresttrip.js";

// 카탈로그 생성기(src/tools/foresttrip-catalog.ts)의 순수 부분. 네트워크는 쓰지 않고 메인 화면과 시설 홈에서 잘라 온 조각을 먹인다.
const entry = (name: string, id: string, full: string, arcd = "1") =>
  `{ name: '${name}', position: '1, 2', url: 'http://x', today: 'fn_goRsvrtTheme(\\'${arcd}\\',\\'${id}\\', \\'${full}\\', \\'eye_${id}\\'); return false;', month: '/m' },`;

const MAIN = `
var x = 1;
dataMap = eval([
 { title: '서울', group: [
  { label: '국립', list: [
   ${entry("유명산", "0101", "유명산 자연휴양림")}
  ]},
  { label: '공립', list: [
   ${entry("가리산", "ID02030002", "가리산 자연휴양림", "2")}
  ]},
  { label: '사립', list: [
   ${entry("삼척활기", "ID02030104", "삼척활기 자연휴양림", "2")}
  ]},
 ]},
]);
second = [ { label: '공립', list: [ ${entry("가리산", "ID02030002", "가리산 자연휴양림", "2")} ] } ];
`;

const home = (options: string) => `<select class="myinbg" id="goodsClssCd" title="상품 유형 선택">
  <option value="">상품 유형 선택</option>
  ${options}
</select><select id="other"><option value="X">no</option></select>`;

describe("숲나들e 카탈로그 생성기", () => {
  describe("메인 화면 지도", () => {
    it("시설 id, 이름, 국립·공립·사립을 읽고 같은 시설이 또 나와도 하나만 둔다", () => {
      expect(parseMapFacilities(MAIN)).toEqual([
        { insttId: "0101", shortName: "유명산", name: "유명산자연휴양림", kind: "국립" },
        { insttId: "ID02030002", shortName: "가리산", name: "가리산자연휴양림", kind: "공립" },
        { insttId: "ID02030104", shortName: "삼척활기", name: "삼척활기자연휴양림", kind: "사립" },
      ]);
    });

    it("지도 데이터가 없으면 던진다", () => {
      expect(() => parseMapFacilities("<html></html>")).toThrow(/dataMap/);
    });
  });

  describe("시설 홈의 유형 드롭다운", () => {
    it("유형 코드와 시설이 채운 라벨을 그대로 구역으로 읽고 안내 항목은 뺀다", () => {
      expect(parseZones(home(`<option value="01001">숲속의집</option>\n<option value="02002">야영데크</option>`))).toEqual([
        { code: "01001", name: "숲속의집", type: "숲속의집" },
        { code: "02002", name: "야영데크", type: "야영데크" },
      ]);
    });

    it("같은 코드가 시설마다 다른 라벨이어도 라벨을 바꾸지 않는다", () => {
      expect(parseZones(home(`<option value="01002">산림문화휴양관</option>`))[0]).toMatchObject({ code: "01002", name: "산림문화휴양관", type: "산림문화휴양관" });
    });

    it("드롭다운이 없거나 코드가 겹치면 던진다", () => {
      expect(() => parseZones("<html></html>")).toThrow(/goodsClssCd/);
      expect(() => parseZones(home(`<option value="01001">a</option><option value="01001">b</option>`))).toThrow(/겹친다/);
    });
  });

  describe("slug", () => {
    it("한글 시설명을 로마자로 옮긴다", () => {
      expect(slugify("유명산")).toBe("yumyeongsan");
      expect(slugify("삼척 활기")).toBe("samcheok-hwalgi");
      expect(slugify("대관령")).toBe("daegwanryeong");
    });

    it("정한 slug는 시설명이 바뀌어도 그대로고 이름만 새로 읽힌다", () => {
      const map = parseMapFacilities(MAIN);
      const slugs = assignSlugs(map, new Map([["0101", "ymsan"]]));
      expect(slugs.get("0101")).toBe("ymsan");
      expect(slugs.get("ID02030002")).toBe("garisan");
    });

    it("slug가 겹치면 실패로 알리고 겹친 시설을 보여 준다", () => {
      const clash = [
        { insttId: "A1", shortName: "가리산" },
        { insttId: "B2", shortName: "가리산" },
      ];
      expect(() => assignSlugs(clash)).toThrow(/겹친다[\s\S]*garisan: A1 가리산, B2 가리산/);
    });

    it("사람이 overrides로 정하면 겹침이 풀린다", () => {
      const clash = [
        { insttId: "A1", shortName: "가리산" },
        { insttId: "B2", shortName: "가리산" },
      ];
      expect([...assignSlugs(clash, new Map(), { B2: "garisan-2" })]).toEqual([
        ["A1", "garisan"],
        ["B2", "garisan-2"],
      ]);
    });

    it("정한 slug와 새 시설의 slug가 겹쳐도 실패한다", () => {
      expect(() => assignSlugs([{ insttId: "A1", shortName: "가리산" }, { insttId: "B2", shortName: "가리산" }], new Map([["A1", "garisan"]]))).toThrow(/겹친다/);
    });

    it("slug를 만들 수 없는 이름은 실패한다", () => {
      expect(() => assignSlugs([{ insttId: "A1", shortName: "()" }])).toThrow(/slug를 만들 수 없다/);
    });
  });

  describe("카탈로그 만들기", () => {
    const map = parseMapFacilities(MAIN);
    const zones = new Map([
      ["0101", parseZones(home(`<option value="02002">야영데크</option>`))],
      ["ID02030002", parseZones(home(`<option value="01001">숲속의집</option>`))],
      ["ID02030104", parseZones(home(`<option value="01007">한옥동</option>`))],
    ]);

    it("시설마다 ref.insttId와 구역을 담고 slug 순으로 정렬한다", () => {
      const built = buildFacilities(map, zones, assignSlugs(map));
      expect(built.map((f) => f.code)).toEqual(["garisan", "samcheokhwalgi", "yumyeongsan"]);
      expect(built[2]).toEqual({ code: "yumyeongsan", name: "유명산자연휴양림", ref: { insttId: "0101" }, zones: [{ code: "02002", name: "야영데크", type: "야영데크" }] });
    });

    it("구역이 하나도 없는 시설이 있으면 실패한다", () => {
      zones.set("0101", []);
      expect(() => buildFacilities(map, zones, assignSlugs(map))).toThrow(/구역이 없는 시설: 0101/);
    });

    it("소스를 그리면 같은 입력에서 같은 결과이고 구역 코드는 따옴표로 감싼다", () => {
      const built = buildFacilities(map, new Map([...zones, ["0101", [{ code: "02002", name: "야영데크", type: "야영데크" }]]]), assignSlugs(map));
      const src = renderCatalogSource(built);
      expect(renderCatalogSource(built)).toBe(src);
      expect(src).toContain(`{ code: "02002", name: "야영데크", type: "야영데크" },`);
      expect(src).toContain(`ref: { insttId: "0101" },`);
    });
  });

  describe("요청 규칙", () => {
    it("공개 화면(메인, 시설 홈)만 허용한다", () => {
      expect(() => assertPublicRead("https://www.foresttrip.go.kr/main.do")).not.toThrow();
      expect(() => assertPublicRead("https://www.foresttrip.go.kr/indvz/main.do?hmpgId=0101")).not.toThrow();
    });

    it.each([
      "https://www.foresttrip.go.kr/com/login.do",
      "https://www.foresttrip.go.kr/rep/or/sssn/monthRsrvtStatus.do?hmpgId=FRIP",
      "https://www.foresttrip.go.kr/pot/rm/fa/selectFcltsArmpListView.do",
      "https://www.foresttrip.go.kr/main.do?next=/login.do",
      "https://example.com/main.do",
    ])("%s는 거부한다", (url) => {
      expect(() => assertPublicRead(url)).toThrow();
    });

    it("GET이 아니면 거부한다", () => {
      expect(() => assertPublicRead("https://www.foresttrip.go.kr/main.do", "POST")).toThrow(/GET만/);
    });

    it("요청 사이를 3초 이상 띄운다", async () => {
      let t = 0;
      const stamps: number[] = [];
      const fetcher = new PoliteFetcher({
        get: async () => (stamps.push(t), { status: 200, body: "ok" }),
        now: () => t,
        sleep: async (ms) => void (t += ms),
      });
      for (const id of ["0101", "0102", "0103"]) await fetcher.text(`https://www.foresttrip.go.kr/indvz/main.do?hmpgId=${id}`);
      expect(stamps).toHaveLength(3);
      expect(stamps[1]! - stamps[0]!).toBeGreaterThanOrEqual(3000);
      expect(stamps[2]! - stamps[1]!).toBeGreaterThanOrEqual(3000);
    });

    it("200이 아닌 응답은 던진다", async () => {
      const fetcher = new PoliteFetcher({ get: async () => ({ status: 403, body: "" }), now: () => 0, sleep: async () => {} });
      await expect(fetcher.text("https://www.foresttrip.go.kr/main.do")).rejects.toThrow(/403/);
    });
  });
});

describe("생성된 숲나들e 카탈로그", () => {
  it("187곳이 모두 있고 각 시설이 ref.insttId와 하나 이상의 구역을 가진다", () => {
    expect(facilities).toHaveLength(187);
    for (const f of facilities) {
      expect((f.ref as { insttId?: string }).insttId, f.code).toBeTruthy();
      expect(f.zones.length, f.code).toBeGreaterThan(0);
    }
  });

  it("slug와 insttId는 서로 겹치지 않고 구역 코드는 시설 안에서 겹치지 않는다", () => {
    expect(new Set(facilities.map((f) => f.code)).size).toBe(facilities.length);
    expect(new Set(facilities.map((f) => (f.ref as { insttId: string }).insttId)).size).toBe(facilities.length);
    for (const f of facilities) expect(new Set(f.zones.map((z) => z.code)).size, f.code).toBe(f.zones.length);
  });

  it("Ticket-1의 시설은 slug와 insttId가 그대로다", () => {
    expect(facilities.find((f) => f.code === "yumyeongsan")?.ref).toEqual({ insttId: "0101" });
    expect(facilities.find((f) => f.code === "samcheok-hwalgi")?.ref).toEqual({ insttId: "ID02030104" });
  });

  it("입화산(울산 중구)은 숲나들e 밖이라 없다", () => {
    expect(facilities.some((f) => f.name.includes("입화산"))).toBe(false);
  });
});
