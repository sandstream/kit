import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { AlpineSourceResponse, ApkFetcher } from "./check-apk-fetch.js";
import { checkApkFloors } from "./check-apk-floors.js";

/** Build a complete ustar fixture with regular files, checksums, padding, and termination. */
export function tarOf(files: Record<string, Buffer | string>, mtime = 0): Buffer {
  const parts: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = typeof text === "string" ? Buffer.from(text) : text;
    const header = Buffer.alloc(512);
    header.write(name, 0, "latin1");
    header.write("0000644\0", 100, "ascii");
    header.write("0000000\0", 108, "ascii");
    header.write("0000000\0", 116, "ascii");
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, "latin1");
    header.write(`${mtime.toString(8).padStart(11, "0")}\0`, 136, "ascii");
    header.fill(32, 148, 156);
    header.write("0", 156, "ascii");
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    parts.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}

export const FIXTURE_KEY_NAME = "kit-fixture.rsa.pub";
let fixturePair: { publicKey: KeyObject; privateKey: KeyObject } | undefined;

function fixtureKeyPair() {
  fixturePair ??= generateKeyPairSync("rsa", { modulusLength: 2048 });
  return fixturePair;
}

export function signApkIndexFixture(payload: Buffer, pax: Buffer = Buffer.alloc(0)): Buffer {
  const signature = sign("RSA-SHA1", payload, fixtureKeyPair().privateKey);
  const tar = tarOf({ [`.SIGN.RSA.${FIXTURE_KEY_NAME}`]: signature });
  const prefix = Buffer.concat([pax, tar.subarray(0, tar.length - 1024)]);
  return Buffer.concat([gzipSync(prefix), payload]);
}

export function unsignedApkIndexFixture(
  branch: string,
  text: string,
  architecture = "x86_64",
  mtime = Math.floor(Date.now() / 1000),
): Buffer {
  const index = text.replace(/^P:[^\n]*\n/gm, (name) => name + `A:${architecture}\n`);
  return gzipSync(tarOf({ DESCRIPTION: `${branch}.0-1-g1234567\n`, APKINDEX: index }, mtime));
}

export function apkIndexFixture(
  branch: string,
  text: string,
  architecture?: string,
  mtime?: number,
): Buffer {
  return signApkIndexFixture(unsignedApkIndexFixture(branch, text, architecture, mtime));
}

export function checkApkFloorsFixture(root: string, fetcher?: ApkFetcher, env?: NodeJS.ProcessEnv) {
  return checkApkFloors(root, fetcher, env, fixtureIndexKeys());
}

export function fixtureIndexKeys() {
  return new Map([[FIXTURE_KEY_NAME, fixtureKeyPair().publicKey]]);
}

export function alpineFixtureFetcher(fetchBody: (url: string) => Promise<Buffer>): ApkFetcher {
  return async (url) => ({
    body: await fetchBody(url),
    lastModified: new Date().toUTCString(),
  });
}

export function alpineHttpFixture({ body, lastModified }: AlpineSourceResponse): Response {
  return new Response(new Uint8Array(body), {
    headers: lastModified === null ? undefined : { "last-modified": lastModified },
  });
}

/** Alpine secdb fixture with the published source identity fields. */
export function secdbFixture(
  branch: string,
  repository: "main" | "community",
  packages: unknown[] = [],
): Buffer {
  return Buffer.from(JSON.stringify({ distroversion: branch, reponame: repository, packages }));
}

/** Fixture for the publisher's root directory listing. */
export function secdbIndexFixture(...names: string[]): Buffer {
  const links = names.map((name) => `<a href="${name}/">${name}/</a>`).join("\r\n");
  return Buffer.from(
    "<html>\r\n<head><title>Index of /</title></head>\r\n<body>\r\n" +
      "<h1>Index of /</h1><hr><pre>" +
      links +
      "\r\n</pre><hr></body>\r\n</html>\r\n",
  );
}
