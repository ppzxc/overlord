// 일괄 조회만 구현한 어댑터의 단건 조회를 일괄 조회로 대신한다.
import { AdapterError, UnitSkipped, type AdapterContext, type AvailabilityQuery, type AvailableSite, type ProviderAdapter } from "./types.js";

/** 조회 단위 하나를 묻는다. 어댑터에 단건 조회가 없으면 일괄 조회로 대신하고, 결과가 오류면 던지며 결과가 없으면 구조 변경으로 본다. */
export async function queryOne(adapter: ProviderAdapter, q: AvailabilityQuery, ctx: AdapterContext): Promise<AvailableSite[]> {
  if (adapter.queryAvailability) return adapter.queryAvailability(q, ctx);
  if (!adapter.queryAvailabilityBatch) throw new AdapterError("unrecognized", `${adapter.id}: 조회 방법이 없다`);
  const result = (await adapter.queryAvailabilityBatch([q], ctx)).get(q);
  if (result instanceof Error) throw result;
  // 단건 경로에는 알림 길이 없어 조회하지 못한 사유를 오류로 올린다.
  if (result instanceof UnitSkipped) throw new AdapterError("transient", result.reason);
  if (result === undefined) throw new AdapterError("unrecognized", `${adapter.id}: 일괄 조회가 조회 단위의 결과를 돌려주지 않았다`);
  return result;
}
