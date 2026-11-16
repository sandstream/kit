import assert from "node:assert/strict";
import { it } from "node:test";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { gunzipSync } from "node:zlib";
import { verifyNpmIntegrity } from "./npm-artifact-integrity.js";

// Fixed abc vectors from ../research.md, section 5; independent of Node crypto.
const H1 = "sha1-qZk+NkcGgWq6PiVxeFDCbJzQ2J0=";
const H256 = "sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=";
const H384 = "sha384-ywB1P0WjXou1oD1pmsZQBycsMqsO3tFjGotgWkP/W+2AhgcroefMI1i67KE0yCWn";
const H512 =
  "sha512-3a81oZNherrMQXNJriBBMRLm+k6JqX6iCp7u5ktV05ohkpkqJ0/BqDa6PCOj/uu9RU1EI2Q86A4qmslPpUyknw==";

it("verifies the independent abc SHA-512 vector with exact byte evidence", () => {
  assert.deepEqual(verifyNpmIntegrity(Buffer.from("abc"), H512), {
    status: "verified",
    algorithm: "sha512",
    matchedToken: H512,
    actualDigest: H512.slice(7),
    byteCount: 3,
  });
});

it("rejects non-Buffer byte inputs at runtime without coercion", () => {
  const hostile = {
    length: 3,
    get 0() {
      throw new Error("Do not read array-like input");
    },
  };
  for (const bytes of [
    undefined,
    null,
    "abc",
    [97, 98, 99],
    new Uint8Array([97, 98, 99]),
    hostile,
  ]) {
    // Reflect crosses the JavaScript boundary without a test-only production API.
    assert.deepEqual(Reflect.apply(verifyNpmIntegrity, undefined, [bytes, H512]), {
      status: "rejected",
      reason: "invalid-bytes",
    });
  }
  const metadata = {
    toString() {
      throw new Error("Do not coerce integrity metadata");
    },
  };
  assert.deepEqual(verifyNpmIntegrity(Buffer.from("abc"), metadata), {
    status: "rejected",
    reason: "malformed-metadata",
  });
});

it("binds evidence to exact compressed bytes, including the gzip header", () => {
  // Independent Python stdlib vector; see provenance/gzip-vector.json.
  const compressed = Buffer.from("1f8b08000000000002ff4b4c4a0600c241243503000000", "hex");
  const changedHeader = Buffer.from("1f8b08000100000002ff4b4c4a0600c241243503000000", "hex");
  const integrity =
    "sha512-KPA3Eo4ijVnnLPueQ892jJ6DVHbRnC4M0ram6NTIywCnyDLWfxjfEXJaTvCT740iGRZJ774iLfzdnFLVenZIXA==";
  assert.deepEqual(verifyNpmIntegrity(compressed, integrity), {
    status: "verified",
    algorithm: "sha512",
    matchedToken: integrity,
    actualDigest: integrity.slice(7),
    byteCount: 23,
  });
  assert.equal(gunzipSync(compressed).toString(), "abc");
  assert.deepEqual(gunzipSync(compressed), gunzipSync(changedHeader));
  for (const bytes of [changedHeader, gunzipSync(compressed), compressed.subarray(0, -1)]) {
    assert.deepEqual(verifyNpmIntegrity(bytes, integrity), {
      status: "rejected",
      reason: "digest-mismatch",
    });
  }
});

it("ignores valid weaker mismatches for every strong algorithm pair", () => {
  const vectors = [H1, H256, H384, H512];
  const lengths = [20, 32, 48, 64];
  for (let selected = 1; selected < vectors.length; selected++) {
    for (let weaker = 0; weaker < selected; weaker++) {
      const zero =
        vectors[weaker].split("-")[0] + "-" + Buffer.alloc(lengths[weaker]).toString("base64");
      for (const metadata of [`${zero} ${vectors[selected]}`, `${vectors[selected]} ${zero}`]) {
        const result = verifyNpmIntegrity(Buffer.from("abc"), metadata);
        assert.equal(result.status, "verified");
        if (result.status === "verified") assert.equal(result.matchedToken, vectors[selected]);
      }
    }
  }
});

it("rejects corrupted, truncated, extended, empty, and newline-altered data", () => {
  for (const bytes of [
    Buffer.from("abd"),
    Buffer.from("ab"),
    Buffer.from("abcd"),
    Buffer.alloc(0),
    Buffer.from("abc\n"),
  ]) {
    for (const token of [H256, H384, H512]) {
      assert.deepEqual(verifyNpmIntegrity(bytes, token), {
        status: "rejected",
        reason: "digest-mismatch",
      });
    }
  }
});

it("never falls back after a stronger mismatch, regardless of token order", () => {
  const vectors = [H1, H256, H384, H512];
  for (let strongest = 1; strongest < vectors.length; strongest++) {
    const token = vectors[strongest];
    const zero = token.slice(0, 7) + Buffer.alloc([20, 32, 48, 64][strongest]).toString("base64");
    for (let weaker = 0; weaker < strongest; weaker++) {
      for (const metadata of [`${vectors[weaker]} ${zero}`, `${zero} ${vectors[weaker]}`]) {
        assert.deepEqual(
          verifyNpmIntegrity(Buffer.from("abc"), metadata),
          {
            status: "rejected",
            reason: "digest-mismatch",
          },
          metadata,
        );
      }
    }
  }
});

it("accepts any matching strongest alternative, even when every weaker digest mismatches", () => {
  for (const [token, length] of [
    [H256, 32],
    [H384, 48],
    [H512, 64],
  ] as const) {
    const zero = token.slice(0, 7) + Buffer.alloc(length).toString("base64");
    const badWeak = "sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    for (const metadata of [
      `${zero} ${token}?match ${badWeak}`,
      `${badWeak} ${token}?match ${zero}`,
      `${zero} ${token}?match ${token}?second`,
    ]) {
      const result = verifyNpmIntegrity(Buffer.from("abc"), metadata);
      assert.equal(result.status, "verified");
      if (result.status === "verified") {
        assert.equal(result.matchedToken, token + "?match");
        assert.equal(result.actualDigest, token.slice(7));
      }
    }
    assert.deepEqual(verifyNpmIntegrity(Buffer.from("abc"), `${zero}?one ${zero}?two`), {
      status: "rejected",
      reason: "digest-mismatch",
    });
  }
});

it("rejects invalid Base64 tails instead of silently dropping their last sextet", () => {
  for (const suffix of ["A", "A=", "A=="]) {
    assert.deepEqual(verifyNpmIntegrity(Buffer.from("abc"), H384 + suffix), {
      status: "rejected",
      reason: "malformed-metadata",
    });
  }
});

it("reports unavailable selected native hashes without weaker fallback and restores crypto", (t) => {
  const nativeCreateHash = crypto.createHash;
  for (const [algorithm, token] of [
    ["sha256", H256],
    ["sha384", H384],
    ["sha512", H512],
  ] as const) {
    const attempted: string[] = [];
    const boundary = t.mock.method(
      crypto,
      "createHash",
      (selected: string, options?: crypto.HashOptions) => {
        attempted.push(selected);
        if (selected === algorithm) throw new Error("Controlled native algorithm unavailability");
        return nativeCreateHash(selected, options);
      },
    );
    syncBuiltinESMExports();
    try {
      const weaker = algorithm === "sha256" ? H1 : H256;
      for (const metadata of [`${weaker} ${token}`, `${token} ${weaker}`]) {
        assert.deepEqual(verifyNpmIntegrity(Buffer.from("abc"), metadata), {
          status: "unsupported",
          reason: "algorithm-unavailable",
          algorithm,
        });
      }
      assert.deepEqual(attempted, [algorithm, algorithm]);
    } finally {
      boundary.mock.restore();
      syncBuiltinESMExports();
    }
    assert.equal(crypto.createHash, nativeCreateHash);
    assert.equal(verifyNpmIntegrity(Buffer.from("abc"), token).status, "verified");
  }
});

it("hashes an owned copy of the supplied view before entering native crypto", (t) => {
  const backing = Buffer.from("prefixabcsuffix");
  const bytes = backing.subarray(6, 9);
  const nativeCreateHash = crypto.createHash;
  const boundary = t.mock.method(
    crypto,
    "createHash",
    (algorithm: string, options?: crypto.HashOptions) => {
      bytes.write("abd");
      return nativeCreateHash(algorithm, options);
    },
  );
  syncBuiltinESMExports();
  try {
    const result = verifyNpmIntegrity(bytes, H512);
    assert.deepEqual(result, {
      status: "verified",
      algorithm: "sha512",
      matchedToken: H512,
      actualDigest: H512.slice(7),
      byteCount: 3,
    });
    assert.equal(bytes.toString(), "abd");
    assert.ok(
      Object.values(result).every(
        (value) => typeof value === "string" || typeof value === "number",
      ),
    );
    const evidence = JSON.stringify(result);
    backing.fill(0);
    assert.equal(JSON.stringify(result), evidence);
  } finally {
    boundary.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(crypto.createHash, nativeCreateHash);
  assert.equal(verifyNpmIntegrity(Buffer.from("abc"), H512).status, "verified");
});

it("bounds metadata at 16384 UTF-8 bytes before token parsing", () => {
  for (const size of [16383, 16384]) {
    const metadata = H512 + "?" + "x".repeat(size - H512.length - 1);
    assert.equal(verifyNpmIntegrity(Buffer.from("abc"), metadata).status, "verified");
  }
  for (const metadata of [
    H512 + "?" + "x".repeat(16385 - H512.length - 1),
    " ".repeat(16385),
    "\u00e9".repeat(8193),
  ]) {
    assert.deepEqual(verifyNpmIntegrity(Buffer.from("abc"), metadata), {
      status: "unsupported",
      reason: "metadata-limit",
      limit: 16384,
    });
  }
  const padded = " ".repeat(16384 - H512.length) + H512;
  assert.equal(verifyNpmIntegrity(Buffer.from("abc"), padded).status, "verified");
});

it("bounds metadata at 64 tokens including duplicates and SHA-1 entries", () => {
  for (const count of [63, 64]) {
    assert.equal(
      verifyNpmIntegrity(Buffer.from("abc"), Array(count).fill(H512).join(" ")).status,
      "verified",
    );
  }
  for (const token of [H1, H512, "x"]) {
    assert.deepEqual(verifyNpmIntegrity(Buffer.from("abc"), Array(65).fill(token).join("\t")), {
      status: "unsupported",
      reason: "token-limit",
      limit: 64,
    });
  }
  assert.deepEqual(
    verifyNpmIntegrity(Buffer.from("abc"), [...Array(63).fill(H512), "sha1-AAAA"].join(" ")),
    {
      status: "rejected",
      reason: "malformed-metadata",
    },
  );
});

it("parses W3C option suffixes separately and preserves the exact matched token", () => {
  const visibleAscii = Array.from({ length: 94 }, (_, index) =>
    String.fromCharCode(index + 33),
  ).join("");
  for (const suffix of ["?", "??", "?foo", "?foo?bar", "?foo??bar?", "?" + visibleAscii]) {
    for (const token of [H256, H384, H512]) {
      assert.deepEqual(verifyNpmIntegrity(Buffer.from("abc"), token + suffix), {
        status: "verified",
        algorithm: token.split("-")[0],
        matchedToken: token + suffix,
        actualDigest: token.slice(7),
        byteCount: 3,
      });
    }
  }
  for (const suffix of ["?\u0000", "?\u007f", "?\u00e9", "?\u000b", "?a b"]) {
    assert.deepEqual(verifyNpmIntegrity(Buffer.from("abc"), H512 + suffix), {
      status: "rejected",
      reason: "malformed-metadata",
    });
  }
});

it("accepts only HTML ASCII whitespace as token separators and preserves token spelling", () => {
  for (const space of [" ", "\t", "\n", "\f", "\r", "\r\n", " \t\r\n\f "]) {
    const result = verifyNpmIntegrity(
      Buffer.from("abc"),
      `${space}${H256}${space}${H512}?${space}`,
    );
    assert.equal(result.status, "verified");
    if (result.status === "verified") assert.equal(result.matchedToken, H512 + "?");
  }
});

it("requires canonical padded Base64, including zero pad bits and the standard alphabet", () => {
  const noncanonical = [
    H1.slice(0, -1),
    H256.slice(0, -1),
    H512.slice(0, -1),
    H512.slice(0, -2),
    H1.slice(0, -2) + "1=",
    H256.slice(0, -2) + "1=",
    H512.slice(0, -3) + "x==",
    H384 + "=",
    H384 + "==",
    H256.replace("+", "-"),
    H512.replace("/", "_"),
  ];
  for (const token of noncanonical) {
    for (const metadata of [token, `${H256} ${token}`, `${token} ${H512}`]) {
      assert.deepEqual(
        verifyNpmIntegrity(Buffer.from("abc"), metadata),
        {
          status: "unsupported",
          reason: "noncanonical-base64",
        },
        metadata,
      );
    }
  }
});

it("enforces exact digest lengths for all recognized algorithms", () => {
  for (const [algorithm, length] of [
    ["sha1", 20],
    ["sha256", 32],
    ["sha384", 48],
    ["sha512", 64],
  ] as const) {
    for (const size of [0, 1, length - 1, length + 1]) {
      const token = `${algorithm}-${Buffer.alloc(size).toString("base64")}`;
      assert.deepEqual(verifyNpmIntegrity(Buffer.from("abc"), `${H512} ${token}`), {
        status: "rejected",
        reason: "malformed-metadata",
      });
    }
  }
});

it("refuses malformed metadata and every malformed token, even beside a matching token", () => {
  const malformed: unknown[] = [
    undefined,
    null,
    true,
    0,
    {},
    [],
    [H512],
    new String(H512),
    "",
    " \t\r\n\f ",
    "sha512",
    "sha512-",
    "-AAAA",
    "sha 512-AAAA",
    "sha512-!!!!",
    "sha512-AA=A",
    "sha512-AAAA===",
    "sha512-AAAA",
    "sha256-AAAA",
    "sha384-AAAA",
    "sha1-AAAA",
    "sha512-" + H256.slice(7),
    "sha256-" + H512.slice(7),
    H512 + "\u0000",
    H512 + "\u007f",
    H512 + "\u0085",
    H512 + "\u00a0",
    H512 + "\u000b" + H256,
  ];
  for (const metadata of malformed) {
    assert.deepEqual(
      verifyNpmIntegrity(Buffer.from("abc"), metadata),
      {
        status: "rejected",
        reason: "malformed-metadata",
      },
      String(metadata),
    );
  }
  for (const bad of ["sha512-!!!!", "sha512-AAAA", "sha384-AAAA", "sha1-AAAA"]) {
    for (const good of [H1, H256, H512]) {
      for (const metadata of [`${good} ${bad}`, `${bad} ${good}`]) {
        assert.deepEqual(
          verifyNpmIntegrity(Buffer.from("abc"), metadata),
          {
            status: "rejected",
            reason: "malformed-metadata",
          },
          metadata,
        );
      }
    }
  }
});

it("reports unknown algorithms without discarding them beside valid weak or strong tokens", () => {
  for (const algorithm of ["sha999", "sha224", "md5", "SHA512", "toString", "constructor"]) {
    const unknown = `${algorithm}-${H512.slice(7)}`;
    for (const metadata of [
      unknown,
      `${H1} ${unknown}`,
      `${unknown} ${H1}`,
      `${H512} ${unknown}`,
      `${unknown} ${H256}`,
    ]) {
      assert.deepEqual(verifyNpmIntegrity(Buffer.from("abc"), metadata), {
        status: "unsupported",
        reason: "unsupported-algorithm",
        algorithm,
      });
    }
  }
});

it("selects the strongest recognized algorithm in every preference order", () => {
  const vectors = [H1, H256, H384, H512];
  function permutations(values: string[]): string[][] {
    return values.length === 0
      ? [[]]
      : values.flatMap((value, index) =>
          permutations(values.filter((_, other) => index !== other)).map((rest) => [
            value,
            ...rest,
          ]),
        );
  }
  // All nonempty subsets and every permutation, including SHA-1-only.
  for (let mask = 1; mask < 16; mask++) {
    const selected = vectors.filter((_, index) => mask & (1 << index));
    const strongest = selected[selected.length - 1];
    for (const order of permutations(selected)) {
      const result = verifyNpmIntegrity(Buffer.from("abc"), order.join(" "));
      if (strongest === H1) {
        assert.deepEqual(result, { status: "rejected", reason: "weak-only" });
      } else {
        assert.deepEqual(
          result,
          {
            status: "verified",
            algorithm: strongest.split("-")[0],
            matchedToken: strongest,
            actualDigest: strongest.slice(7),
            byteCount: 3,
          },
          order.join(" "),
        );
      }
    }
  }
});
