// 숲나들e 카탈로그 생성기. `npm run catalog:foresttrip [-- --cache <dir>]`.
// 공개 GET만 쓴다: 메인 화면 1건과 시설 홈 시설당 1건. 요청 사이는 3.5초, 로그인·예약·결제 경로는 `assertPublicRead`가 막는다.
// `--cache <dir>`를 주면 받은 화면을 그 폴더에 두고 다시 쓴다(네트워크 재조회를 피한다). 폴더는 리포 밖에 둔다.
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { facilities as existing } from "../catalogs/foresttrip.js";
import { assignSlugs, buildFacilities, parseMapFacilities, parseZones, PoliteFetcher, renderCatalogSource } from "./foresttrip-catalog.js";
import { slugOverrides } from "./foresttrip-slug-overrides.js";

const ORIGIN = "https://www.foresttrip.go.kr";
const UA = "overlord-availability-poller/0.1 (catalog generator)";
const cacheIndex = process.argv.indexOf("--cache");
const cacheDir = cacheIndex >= 0 ? process.argv[cacheIndex + 1] : undefined;
if (cacheDir) mkdirSync(cacheDir, { recursive: true });

const fetcher = new PoliteFetcher({
  get: async (url) => {
    const res = await fetch(url, { method: "GET", headers: { "user-agent": UA }, redirect: "error", signal: AbortSignal.timeout(30_000) });
    return { status: res.status, body: await res.text() };
  },
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

async function page(key: string, path: string): Promise<string> {
  const file = cacheDir ? join(cacheDir, `${key}.html`) : undefined;
  if (file && existsSync(file)) return readFileSync(file, "utf8");
  const body = await fetcher.text(`${ORIGIN}${path}`);
  if (file) writeFileSync(file, body);
  return body;
}

const map = parseMapFacilities(await page("main", "/main.do"));
const kinds = map.reduce<Record<string, number>>((n, f) => ({ ...n, [f.kind]: (n[f.kind] ?? 0) + 1 }), {});
console.log(`지도 시설 ${map.length}곳`, kinds);

const fixed = new Map(existing.map((f) => [(f.ref as { insttId: string }).insttId, f.code]));
const slugs = assignSlugs(map, fixed, slugOverrides);

const zonesById = new Map<string, ReturnType<typeof parseZones>>();
for (const [i, f] of map.entries()) {
  zonesById.set(f.insttId, parseZones(await page(`home-${f.insttId}`, `/indvz/main.do?hmpgId=${encodeURIComponent(f.insttId)}`)));
  if ((i + 1) % 20 === 0) console.log(`시설 홈 ${i + 1}/${map.length}`);
}

const out = buildFacilities(map, zonesById, slugs);
writeFileSync("src/catalogs/foresttrip.ts", renderCatalogSource(out));
console.log(`카탈로그 ${out.length}곳, 구역 ${out.reduce((n, f) => n + f.zones.length, 0)}개`);
