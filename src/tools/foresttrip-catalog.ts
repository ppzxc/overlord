// 숲나들e 카탈로그 생성기의 순수 부분. 네트워크는 하지 않고, 받아 둔 HTML을 읽어 시설·구역과 slug를 만들고 카탈로그 소스를 그린다.
// 요청 쪽(공개 GET만, 호스트당 3초 이상 간격)은 `PoliteFetcher`와 `assertPublicRead`가 맡고 실행은 `gen-foresttrip-catalog.ts`가 한다.
import type { FacilityInfo, ZoneInfo } from "../types.js";

export interface MapFacility {
  insttId: string;
  /** 지도에 쓰인 짧은 이름. slug의 재료다. 예: 유명산 */
  shortName: string;
  /** 지도가 시설 홈으로 넘기는 정식 이름에서 공백을 뺀 값. 예: 유명산자연휴양림 */
  name: string;
  /** 국립, 공립, 사립 */
  kind: string;
}

/**
 * 메인 화면 지도(`dataMap`)에서 시설을 읽는다. 같은 시설이 지도에 두 번 나와도(시도별 지도와 권역 지도) 먼저 나온 것 하나만 둔다.
 * 구분(국립·공립·사립)은 시설 앞에 가장 가까이 나온 `label`이다.
 */
export function parseMapFacilities(html: string): MapFacility[] {
  const start = html.indexOf("dataMap = eval([");
  if (start < 0) throw new Error("메인 화면에서 지도 데이터(dataMap)를 찾지 못했다");
  const re = /label:\s*'(국립|공립|사립)'|name:\s*'([^']*)'[^\n]*?fn_goRsvrtTheme\(\\'\d\\',\s*\\'([^\\']+)\\',\s*\\'([^\\]*)\\'/g;
  re.lastIndex = start;
  const seen = new Map<string, MapFacility>();
  let kind = "";
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[1]) {
      kind = m[1];
      continue;
    }
    const insttId = m[3]!;
    if (seen.has(insttId)) continue;
    seen.set(insttId, { insttId, shortName: m[2]!.trim(), name: m[4]!.replace(/\s+/g, ""), kind });
  }
  return [...seen.values()];
}

/** 시설 홈의 `상품 유형 선택` 드롭다운에서 구역(유형 코드와 시설이 채운 라벨)을 읽는다. 첫 안내 항목(빈 값)은 뺀다. */
export function parseZones(homeHtml: string): ZoneInfo[] {
  const select = /<select[^>]*id="goodsClssCd"[^>]*>([\s\S]*?)<\/select>/.exec(homeHtml);
  if (!select) throw new Error("시설 홈에서 상품 유형 드롭다운(goodsClssCd)을 찾지 못했다");
  const zones: ZoneInfo[] = [];
  for (const m of select[1]!.matchAll(/<option\s+value="([^"]*)"[^>]*>([^<]*)<\/option>/g)) {
    const code = m[1]!.trim();
    if (!code) continue;
    const name = m[2]!.trim();
    if (zones.some((z) => z.code === code)) throw new Error(`유형 코드가 겹친다: ${code}`);
    zones.push({ code, name, type: name });
  }
  return zones;
}

const INITIALS = ["g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h"];
const VOWELS = ["a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i"];
const FINALS = ["", "k", "kk", "k", "n", "n", "n", "t", "l", "k", "m", "p", "l", "l", "p", "l", "m", "p", "p", "t", "t", "ng", "t", "t", "k", "t", "p", "t"];

/** 한글 음절을 로마자로 옮긴다(국어의 로마자 표기법 글자 그대로, 음운 변화는 적용하지 않는다). 한글이 아닌 영숫자는 소문자로 두고 나머지는 하이픈이다. */
export function slugify(name: string): string {
  let out = "";
  for (const ch of name) {
    const c = ch.codePointAt(0)!;
    if (c >= 0xac00 && c <= 0xd7a3) {
      const i = c - 0xac00;
      out += INITIALS[Math.floor(i / 588)]! + VOWELS[Math.floor((i % 588) / 28)]! + FINALS[i % 28]!;
    } else if (/[a-z0-9]/i.test(ch)) out += ch.toLowerCase();
    else out += "-";
  }
  return out.replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/**
 * 시설마다 slug를 정한다. 이미 정한 slug(`fixed`: insttId → slug)는 그대로 둔다. 시설명이 바뀌어도 slug는 바뀌지 않는다.
 * 새 시설은 `overrides`(사람이 정한 값)가 있으면 그것을, 없으면 짧은 이름의 로마자를 쓴다.
 * 어느 쪽이든 slug가 서로 겹치거나 비면 하나도 정하지 않고 던진다. 사람이 `overrides`에 직접 정한다.
 */
export function assignSlugs(
  facilities: readonly Pick<MapFacility, "insttId" | "shortName">[],
  fixed: ReadonlyMap<string, string> = new Map(),
  overrides: Readonly<Record<string, string>> = {},
): Map<string, string> {
  const slugs = new Map<string, string>();
  for (const f of facilities) slugs.set(f.insttId, fixed.get(f.insttId) ?? overrides[f.insttId] ?? slugify(f.shortName));
  const owners = new Map<string, string[]>();
  for (const f of facilities) {
    const slug = slugs.get(f.insttId)!;
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) throw new Error(`slug를 만들 수 없다: ${f.insttId} ${f.shortName} -> "${slug}". overrides에 직접 정한다`);
    owners.set(slug, [...(owners.get(slug) ?? []), `${f.insttId} ${f.shortName}`]);
  }
  const clashes = [...owners].filter(([, who]) => who.length > 1);
  if (clashes.length) {
    throw new Error(`slug가 겹친다. overrides에 insttId별로 직접 정한다:\n${clashes.map(([slug, who]) => `  ${slug}: ${who.join(", ")}`).join("\n")}`);
  }
  return slugs;
}

/** 지도 시설과 시설별 구역으로 카탈로그 시설 목록을 만든다. 구역이 없는 시설은 던진다. slug 순으로 정렬한다. */
export function buildFacilities(map: readonly MapFacility[], zonesById: ReadonlyMap<string, ZoneInfo[]>, slugs: ReadonlyMap<string, string>): FacilityInfo[] {
  return map
    .map((f): FacilityInfo => {
      const zones = zonesById.get(f.insttId);
      if (!zones?.length) throw new Error(`구역이 없는 시설: ${f.insttId} ${f.name}`);
      return { code: slugs.get(f.insttId)!, name: f.name, ref: { insttId: f.insttId }, zones };
    })
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

const HEADER = `// 숲나들e(\`www.foresttrip.go.kr\`) 시설·구역 카탈로그. 정적 목록이며 어댑터 로직과 네트워크 코드는 두지 않는다. 읽는 방법과 판정은 어댑터(\`src/adapters/foresttrip.ts\`)가 한다.
// 이 파일은 생성물이다. \`npm run catalog:foresttrip\`(src/tools/gen-foresttrip-catalog.ts)가 메인 화면 지도와 시설 홈 드롭다운을 공개 GET으로 읽어 만든다. 손으로 고치지 않는다.
// 시설 \`ref\`는 \`{ insttId }\`이고 정본이다. \`code\`(slug)는 한 번 정하면 고정이며 시설명이 바뀌면 \`name\`만 갱신된다. 겹치는 slug는 생성기의 overrides(src/tools/foresttrip-slug-overrides.ts)에 사람이 정한다.
// 구역 \`code\`는 상품 유형 코드(\`goodsClsscCd\`)이고 \`name\`·\`type\`은 시설이 채운 라벨 그대로다. 같은 코드가 시설마다 다른 이름일 수 있고 코드로 유형(카라반 등)을 가르지 않는다.
// 자리 목록은 두지 않는다. 자리는 상품(\`goodsId\`)이고 로그인 응답의 상품 목록에서 읽는다. 입화산(울산 중구)은 숲나들e 밖이라 없다.
import type { FacilityInfo } from "../types.js";

export const facilities: FacilityInfo[] = [
`;

/** 카탈로그 소스(`src/catalogs/foresttrip.ts`)를 그린다. 같은 입력이면 같은 출력이다. */
export function renderCatalogSource(facilities: readonly FacilityInfo[]): string {
  const q = JSON.stringify;
  const blocks = facilities.map((f) => {
    const ref = f.ref as Record<string, string>;
    const zones = f.zones.map((z) => `      { code: ${q(z.code)}, name: ${q(z.name)}, type: ${q(z.type)} },`).join("\n");
    return `  {\n    code: ${q(f.code)},\n    name: ${q(f.name)},\n    ref: { insttId: ${q(ref.insttId)} },\n    zones: [\n${zones}\n    ],\n  },`;
  });
  return `${HEADER}${blocks.join("\n")}\n];\n`;
}

const HOST = "www.foresttrip.go.kr";
/** 생성기가 읽어도 되는 공개 화면. 로그인·예약·결제 경로는 이 목록에 없다. */
const ALLOWED_PATHS = ["/main.do", "/indvz/main.do"];
const FORBIDDEN = /login|logout|rsrvt|reserv|pay|pymnt|cancel|mber|member|join|pwd|password/i;

/** 공개 GET만 허용한다. 호스트가 다르거나 허용 목록 밖이거나 금지 단어가 든 경로는 던진다. */
export function assertPublicRead(url: string, method = "GET"): void {
  const u = new URL(url);
  if (method !== "GET") throw new Error(`GET만 보낸다: ${method} ${url}`);
  if (u.host !== HOST) throw new Error(`숲나들e 밖 호스트다: ${u.host}`);
  if (!ALLOWED_PATHS.includes(u.pathname) || FORBIDDEN.test(u.pathname + u.search)) throw new Error(`허용하지 않는 경로다: ${u.pathname}${u.search}`);
}

export interface PoliteFetcherDeps {
  get: (url: string) => Promise<{ status: number; body: string }>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** 요청 사이 최소 간격(ms). 기본 3500으로 3초 이상이다. */
  minIntervalMs?: number;
}

/** 요청 사이를 `minIntervalMs` 이상 띄우는 GET 전용 읽기. 한 번에 하나만 나간다고 가정한다(호스트가 하나다). */
export class PoliteFetcher {
  private last: number | undefined;
  constructor(private readonly deps: PoliteFetcherDeps) {}

  async text(url: string): Promise<string> {
    assertPublicRead(url);
    const gap = this.deps.minIntervalMs ?? 3500;
    if (this.last !== undefined) {
      const wait = this.last + gap - this.deps.now();
      if (wait > 0) await this.deps.sleep(wait);
    }
    this.last = this.deps.now();
    const res = await this.deps.get(url);
    if (res.status !== 200) throw new Error(`${url} 응답 ${res.status}`);
    return res.body;
  }
}
