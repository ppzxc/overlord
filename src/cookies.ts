interface Cookie {
  name: string;
  value: string;
  domain: string;
  /** Domain 속성 없이 받은 쿠키. 받은 호스트에만 싣는다. */
  hostOnly: boolean;
}

const domainMatches = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);
const cookieKey = (c: Pick<Cookie, "name" | "domain" | "hostOnly">) => `${c.hostOnly ? "" : "."}${c.domain} ${c.name}`;

/** 예약처 하나가 들고 있는 쿠키. RFC 6265의 일부만 따른다. */
export class CookieJar {
  private readonly cookies = new Map<string, Cookie>();

  /**
   * Set-Cookie 값들을 담는다. Domain 속성이 없으면 받은 호스트에만, 있으면 그 도메인과 하위 호스트에 싣는다.
   * 받은 호스트와 맞지 않는 Domain은 버린다. Max-Age가 0 이하이거나 Expires가 지났으면 지운다. 경로는 보지 않는다.
   */
  store(host: string, setCookie: string[], now: number): void {
    for (const line of setCookie) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair!.indexOf("=");
      if (eq <= 0) continue;
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      let maxAgeExpired: boolean | undefined;
      let expiresPassed = false;
      let domain: string | undefined;
      for (const a of attrs) {
        const [key = "", val = ""] = a.split("=").map((x) => x.trim());
        if (/^max-age$/i.test(key)) maxAgeExpired = Number(val) <= 0;
        else if (/^expires$/i.test(key)) expiresPassed = Date.parse(val) <= now;
        else if (/^domain$/i.test(key) && val) domain = val.replace(/^\./, "").toLowerCase();
      }
      // Max-Age가 있으면 Expires보다 앞선다.
      const expired = maxAgeExpired ?? expiresPassed;
      if (domain !== undefined && !domainMatches(host, domain)) continue;
      const cookie: Cookie = { name, value, domain: domain ?? host, hostOnly: domain === undefined };
      if (expired) this.cookies.delete(cookieKey(cookie));
      else this.cookies.set(cookieKey(cookie), cookie);
    }
  }

  /** host로 보낼 Cookie 헤더 값. 없으면 빈 문자열. */
  header(host: string): string {
    return [...this.cookies.values()]
      .filter((c) => (c.hostOnly ? c.domain === host : domainMatches(host, c.domain)))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }

  clear(): void {
    this.cookies.clear();
  }
}
