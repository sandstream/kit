import { verify, type KeyLike } from "node:crypto";
import {
  ApkIndexFormatError,
  readApkIndexArchive,
  readApkIndexEnvelope,
} from "./alpine-index-archive.js";

export type ApkIndexKeys = ReadonlyMap<string, KeyLike>;

// The x86_64 keys from Alpine's alpine-keys APKBUILD at
// https://github.com/alpinelinux/aports/tree/d76eb1f5547d1294ea66305d592337d246c5a62e/main/alpine-keys
const ALPINE_KEYS: ApkIndexKeys = new Map([
  [
    "alpine-devel@lists.alpinelinux.org-4a6a0840.rsa.pub",
    `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1yHJxQgsHQREclQu4Ohe
qxTxd1tHcNnvnQTu/UrTky8wWvgXT+jpveroeWWnzmsYlDI93eLI2ORakxb3gA2O
Q0Ry4ws8vhaxLQGC74uQR5+/yYrLuTKydFzuPaS1dK19qJPXB8GMdmFOijnXX4SA
jixuHLe1WW7kZVtjL7nufvpXkWBGjsfrvskdNA/5MfxAeBbqPgaq0QMEfxMAn6/R
L5kNepi/Vr4S39Xvf2DzWkTLEK8pcnjNkt9/aafhWqFVW7m3HCAII6h/qlQNQKSo
GuH34Q8GsFG30izUENV9avY7hSLq7nggsvknlNBZtFUcmGoQrtx3FmyYsIC8/R+B
ywIDAQAB
-----END PUBLIC KEY-----`,
  ],
  [
    "alpine-devel@lists.alpinelinux.org-5261cecb.rsa.pub",
    `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwlzMkl7b5PBdfMzGdCT0
cGloRr5xGgVmsdq5EtJvFkFAiN8Ac9MCFy/vAFmS8/7ZaGOXoCDWbYVLTLOO2qtX
yHRl+7fJVh2N6qrDDFPmdgCi8NaE+3rITWXGrrQ1spJ0B6HIzTDNEjRKnD4xyg4j
g01FMcJTU6E+V2JBY45CKN9dWr1JDM/nei/Pf0byBJlMp/mSSfjodykmz4Oe13xB
Ca1WTwgFykKYthoLGYrmo+LKIGpMoeEbY1kuUe04UiDe47l6Oggwnl+8XD1MeRWY
sWgj8sF4dTcSfCMavK4zHRFFQbGp/YFJ/Ww6U9lA3Vq0wyEI6MCMQnoSMFwrbgZw
wwIDAQAB
-----END PUBLIC KEY-----`,
  ],
  [
    "alpine-devel@lists.alpinelinux.org-6165ee59.rsa.pub",
    `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAutQkua2CAig4VFSJ7v54
ALyu/J1WB3oni7qwCZD3veURw7HxpNAj9hR+S5N/pNeZgubQvJWyaPuQDm7PTs1+
tFGiYNfAsiibX6Rv0wci3M+z2XEVAeR9Vzg6v4qoofDyoTbovn2LztaNEjTkB+oK
tlvpNhg1zhou0jDVYFniEXvzjckxswHVb8cT0OMTKHALyLPrPOJzVtM9C1ew2Nnc
3848xLiApMu3NBk0JqfcS3Bo5Y2b1FRVBvdt+2gFoKZix1MnZdAEZ8xQzL/a0YS5
Hd0wj5+EEKHfOd3A75uPa/WQmA+o0cBFfrzm69QDcSJSwGpzWrD1ScH3AK8nWvoj
v7e9gukK/9yl1b4fQQ00vttwJPSgm9EnfPHLAtgXkRloI27H6/PuLoNvSAMQwuCD
hQRlyGLPBETKkHeodfLoULjhDi1K2gKJTMhtbnUcAA7nEphkMhPWkBpgFdrH+5z4
Lxy+3ek0cqcI7K68EtrffU8jtUj9LFTUC8dERaIBs7NgQ/LfDbDfGh9g6qVj1hZl
k9aaIPTm/xsi8v3u+0qaq7KzIBc9s59JOoA8TlpOaYdVgSQhHHLBaahOuAigH+VI
isbC9vmqsThF2QdDtQt37keuqoda2E6sL7PUvIyVXDRfwX7uMDjlzTxHTymvq2Ck
htBqojBnThmjJQFgZXocHG8CAwEAAQ==
-----END PUBLIC KEY-----`,
  ],
]);

export function verifyApkIndex(gz: Buffer, keys: ApkIndexKeys = ALPINE_KEYS) {
  const { name, signature, payload, maxPayloadInflatedBytes } = readApkIndexEnvelope(gz);
  const signing = /^\.SIGN\.(RSA|RSA256)\.([a-zA-Z0-9._+@-]+)$/.exec(name);
  if (!signing) throw new ApkIndexFormatError("unsupported signature method", "unsupported");
  const signingKey = signing[2];
  const key = keys.get(signingKey);
  if (!key) throw new ApkIndexFormatError("signature key is not trusted for x86_64", "unsupported");
  const algorithm = signing[1] === "RSA" ? "RSA-SHA1" : "RSA-SHA256";
  let verified: boolean;
  try {
    verified = verify(algorithm, payload, key, signature);
  } catch {
    throw new ApkIndexFormatError("signature verification unavailable", "unsupported");
  }
  if (!verified) throw new ApkIndexFormatError("signature verification failed", "malformed");
  return { ...readApkIndexArchive(payload, maxPayloadInflatedBytes), signingKey };
}
