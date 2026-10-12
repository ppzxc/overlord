import * as cheerio from "cheerio";
import { AdapterError, type AvailabilityQuery } from "./types.js";
import { addDays } from "./schedule.js";

/** 추첨 회차 하나의 일정. 야영장 기준이다. */
export interface LotterySchedule {
  /** 추첨 대상 기간(입실 가능 날짜, 양끝 포함). YYYY-MM-DD */
  from: string;
  to: string;
  /** 야영장 빈자리 접수 개시 시각(절대 시각 ms). */
  openAt: number;
  /** "추첨제 대상 (야영장) N 개소"의 N. */
  campCount: number;
}

const DATE = /(\d{4})\.(\d{2})\.(\d{2})/g;
const isoDates = (text: string) => [...text.matchAll(DATE)].map((m) => `${m[1]}-${m[2]}-${m[3]}`);

/**
 * `selectCampLottery.do` 화면에서 회차 일정을 읽는다. 항목 이름(`dt`)으로 값을 찾고, 빈자리 접수일은 "추첨제 운영 안내" 표의 야영장 행에서 읽는다.
 * 읽어야 할 값이 하나라도 없으면 화면 모양이 바뀐 것이라 AdapterError("unrecognized")를 던진다.
 */
export function parseLottery(html: string): LotterySchedule {
  const $ = cheerio.load(html);
  const dd = (label: string) => $("dl").filter((_, dl) => $(dl).children("dt").first().text().trim() === label).children("dd").first();
  const period = isoDates(dd("추첨 대상 기간").text());
  if (period.length !== 2) throw new AdapterError("unrecognized", "추첨 대상 기간을 읽지 못했다");
  const count = /\(야영장\)\s*(\d+)\s*개소/.exec(dd("추첨제 대상").text());
  if (!count) throw new AdapterError("unrecognized", "추첨제 대상 야영장 개소 수를 읽지 못했다");
  const row = $("table.open-info tbody tr")
    .filter((_, tr) => $(tr).children("td").first().text().trim() === "야영장")
    .first();
  const open = /(\d{4})\.(\d{2})\.(\d{2})\s*\((\d{2}):(\d{2})\)/.exec(row.children("td").eq(1).text());
  if (!open) throw new AdapterError("unrecognized", "야영장 빈자리 접수일을 읽지 못했다");
  const openAt = Date.parse(`${open[1]}-${open[2]}-${open[3]}T${open[4]}:${open[5]}:00+09:00`);
  return { from: period[0]!, to: period[1]!, openAt, campCount: Number(count[1]) };
}

/** 추첨 대상 기간의 밤을 하나라도 포함하고 빈자리 접수가 아직 열리지 않았으면 조회 단위에서 뺀다. 대상 야영장이 0개소면 빼지 않는다. */
export function isLotteryHeld(s: LotterySchedule | undefined, q: AvailabilityQuery, now: Date): boolean {
  if (!s || s.campCount === 0 || now.getTime() >= s.openAt) return false;
  for (let i = 0; i < q.nights; i++) {
    const night = addDays(q.checkIn, i);
    if (night >= s.from && night <= s.to) return true;
  }
  return false;
}
