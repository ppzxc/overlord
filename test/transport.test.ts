import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rootCertificates } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTransport, loadExtraCa } from "../src/transport.js";

// 이 테스트는 실제 transport 함수와 로컬 HTTPS 서버를 쓴다(경계 2). 인증서는 테스트 안에서 openssl로 만든다.
const openssl = (cwd: string, ...args: string[]) => execFileSync("openssl", args, { cwd, stdio: "pipe" });

interface Pki {
  root: string;
  intermediate: string;
  leaf: string;
  leafKey: string;
}

/** 루트 -> 중간 -> 말단. 말단은 127.0.0.1용 서버 인증서다. */
function makePki(dir: string, name: string): Pki {
  const w = (file: string, text: string) => writeFileSync(join(dir, file), text);
  const keyArgs = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
  w(`${name}-int.ext`, "basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n");
  w(
    `${name}-leaf.ext`,
    "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n",
  );
  openssl(dir, "req", "-x509", ...keyArgs, "-keyout", `${name}-root.key`, "-out", `${name}-root.pem`, "-days", "2", "-subj", `/CN=${name} Test Root`,
    "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
  openssl(dir, "req", "-new", ...keyArgs, "-keyout", `${name}-int.key`, "-out", `${name}-int.csr`, "-subj", `/CN=${name} Test Intermediate`);
  openssl(dir, "x509", "-req", "-in", `${name}-int.csr`, "-CA", `${name}-root.pem`, "-CAkey", `${name}-root.key`, "-CAcreateserial",
    "-out", `${name}-int.pem`, "-days", "2", "-extfile", `${name}-int.ext`);
  openssl(dir, "req", "-new", ...keyArgs, "-keyout", `${name}-leaf.key`, "-out", `${name}-leaf.csr`, "-subj", `/CN=${name} Test Leaf`);
  openssl(dir, "x509", "-req", "-in", `${name}-leaf.csr`, "-CA", `${name}-int.pem`, "-CAkey", `${name}-int.key`, "-CAcreateserial",
    "-out", `${name}-leaf.pem`, "-days", "2", "-extfile", `${name}-leaf.ext`);
  const r = (file: string) => readFileSync(join(dir, file), "utf8");
  return { root: r(`${name}-root.pem`), intermediate: r(`${name}-int.pem`), leaf: r(`${name}-leaf.pem`), leafKey: r(`${name}-leaf.key`) };
}

const listen = (server: Server) =>
  new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => resolve(`https://127.0.0.1:${(server.address() as AddressInfo).port}`)));

/** 연결 실패의 원인 코드. 그냥 reject만 보면 ECONNREFUSED 같은 엉뚱한 실패도 통과한다. */
async function failureCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (e) {
    return ((e as Error).cause as { code?: string } | undefined)?.code;
  }
  throw new Error("연결이 성공했다");
}

let dir: string;
let trusted: Pki;
let untrusted: Pki;
const servers: Server[] = [];
let trustedUrl: string;
let untrustedUrl: string;
let redirectUrl: string;

// 서버는 말단 인증서만 보낸다(예약처가 중간 인증서를 빠뜨린 상황).
const serve = async (pki: Pki, cert: string, handler?: Parameters<typeof createServer>[1]) => {
  const server = createServer({ key: pki.leafKey, cert }, handler ?? ((_req, res) => res.end("ok")));
  servers.push(server);
  return listen(server);
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "overlord-tls-"));
  trusted = makePki(dir, "trusted");
  untrusted = makePki(dir, "untrusted");
  trustedUrl = await serve(trusted, trusted.leaf);
  // 믿지 않는 루트로 서명된 서버는 자기 중간 인증서까지 보낸다. 거부 이유가 중간 인증서 누락이 아니라 루트임을 보이려는 것이다.
  untrustedUrl = await serve(untrusted, `${untrusted.leaf}${untrusted.intermediate}`);
  redirectUrl = await serve(trusted, trusted.leaf, (_req, res) => {
    res.writeHead(302, { Location: "/next", "Set-Cookie": ["a=1; Path=/", "b=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT"] });
    res.end("moved");
  });
});

afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise((resolve) => { s.closeAllConnections(); s.close(resolve); })));
  rmSync(dir, { recursive: true, force: true });
});

const get = (url: string) => ({ method: "GET" as const, url, headers: {}, timeoutMs: 5_000 });

describe("transport의 TLS 신뢰 목록", () => {
  it("말단 인증서만 보내는 서버에 중간 인증서를 더한 transport는 검증을 끄지 않고 연결된다", async () => {
    const transport = createTransport({ roots: [trusted.root], extraCa: [trusted.intermediate] });
    try {
      const res = await transport(get(trustedUrl));
      expect(res).toMatchObject({ status: 200, body: "ok" });
    } finally {
      await transport.close();
    }
  });

  it("중간 인증서를 더하지 않은 transport는 같은 서버에서 검증 실패로 거부한다", async () => {
    const transport = createTransport({ roots: [trusted.root] });
    try {
      expect(await failureCode(transport(get(trustedUrl)))).toBe("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
    } finally {
      await transport.close();
    }
  });

  it("신뢰 목록에 없는 루트로 서명된 서버는 중간 인증서를 더한 transport에서도 거부한다", async () => {
    const transport = createTransport({ roots: [trusted.root], extraCa: [trusted.intermediate] });
    try {
      expect(["UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "SELF_SIGNED_CERT_IN_CHAIN"]).toContain(await failureCode(transport(get(untrustedUrl))));
    } finally {
      await transport.close();
    }
  });

  it("리다이렉트를 따라가지 않으면 3xx 응답과 Location, 쿠키를 그대로 돌려준다", async () => {
    const transport = createTransport({ roots: [trusted.root], extraCa: [trusted.intermediate] });
    try {
      const res = await transport({ ...get(redirectUrl), redirect: "manual" });
      expect(res).toMatchObject({ status: 302, location: "/next", setCookie: ["a=1; Path=/", "b=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT"] });
    } finally {
      await transport.close();
    }
  });
});

describe("저장소의 중간 인증서", () => {
  const certsDir = new URL("../certs/", import.meta.url);

  it("Sectigo DV R36이고 내장 루트 R46이 서명했으며 2036-03-21까지 유효하다", () => {
    const [pem] = loadExtraCa(certsDir);
    const r36 = new X509Certificate(pem!);
    expect(r36.subject).toBe("C=GB\nO=Sectigo Limited\nCN=Sectigo Public Server Authentication CA DV R36");
    expect(r36.issuer).toBe("C=GB\nO=Sectigo Limited\nCN=Sectigo Public Server Authentication Root R46");
    expect(r36.validTo).toBe("Mar 21 23:59:59 2036 GMT");
    expect(r36.ca).toBe(true);
    const r46 = rootCertificates.map((p) => new X509Certificate(p)).find((c) => c.subject === r36.issuer);
    expect(r46, "Node 내장 루트에 R46이 있어야 한다").toBeDefined();
    expect(r36.checkIssued(r46!)).toBe(true);
    expect(r36.verify(r46!.publicKey)).toBe(true);
  });

  it("PEM 옆 README에 출처와 지문이 적혀 있다", () => {
    const [pem] = loadExtraCa(certsDir);
    const fingerprint = new X509Certificate(pem!).fingerprint256;
    const readme = readFileSync(new URL("README.md", certsDir), "utf8");
    expect(readme).toContain(fingerprint);
    expect(readme).toContain("crt.sectigo.com");
    expect(readme).toContain("2036-03-21");
  });

  it("폴더의 PEM을 모두 읽는다", () => {
    const pems = readdirSync(certsDir).filter((f) => f.endsWith(".pem"));
    expect(loadExtraCa(certsDir)).toHaveLength(pems.length);
  });
});
