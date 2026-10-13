// 고래불 자리 id 규칙. 어댑터(파싱)와 카탈로그(자리 목록)가 함께 쓰는 작은 공용 모듈이다.

/** 자리 id의 접두어. 숲속야영장(DKA)은 A02처럼 끝 글자만, 나머지는 CAA11처럼 구역 코드를 쓴다. */
export const seatPrefix = (zone: string) => (zone.startsWith("DK") ? zone.slice(-1) : zone);
