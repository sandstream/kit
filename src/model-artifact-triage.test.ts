import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { triageModelArtifact } from "./model-artifact-triage.js";

describe("triageModelArtifact", () => {
  it("FAILS a pickle-family (code-exec-on-load) format with high confidence", () => {
    for (const f of ["model.pkl", "weights.pt", "ckpt.bin", "x.ckpt", "a.pth"]) {
      const r = triageModelArtifact(f, { provenanceVerified: true });
      assert.equal(r.formatRisk, "code-exec", f);
      assert.equal(r.passed, false, f);
      assert.ok(r.findings.some((x) => x.confidence === "high"), f);
    }
  });

  it("passes .safetensors (data-only) but keeps an untrusted-data advisory", () => {
    const r = triageModelArtifact("model.safetensors", { provenanceVerified: true });
    assert.equal(r.formatRisk, "data-only");
    assert.equal(r.passed, true);
    assert.ok(r.findings.every((x) => x.confidence === "heuristic"));
  });

  it("flags .gguf as loader-hardening-sensitive (advisory, still passes)", () => {
    const r = triageModelArtifact("llama.gguf", { provenanceVerified: true });
    assert.equal(r.formatRisk, "loader-hardening");
    assert.equal(r.passed, true);
    assert.ok(r.findings.some((x) => /loader-hardening/.test(x.label)));
  });

  it("treats an unknown extension as untrusted (advisory)", () => {
    const r = triageModelArtifact("weights.xyz", { provenanceVerified: true });
    assert.equal(r.formatRisk, "unknown");
    assert.equal(r.passed, true);
  });

  it("adds an unverified-provenance finding when no verification is supplied", () => {
    const r = triageModelArtifact("model.safetensors");
    assert.ok(r.findings.some((x) => /provenance/.test(x.label)));
  });

  it("flags a zero-byte artifact", () => {
    const r = triageModelArtifact("model.gguf", { sizeBytes: 0, provenanceVerified: true });
    assert.ok(r.findings.some((x) => /zero-byte/.test(x.label)));
  });

  it("is deterministic and strips the directory (basename only)", () => {
    const a = triageModelArtifact("/tmp/downloads/model.pkl");
    const b = triageModelArtifact("model.pkl");
    assert.equal(a.artifact, "model.pkl");
    assert.equal(a.formatRisk, b.formatRisk);
    assert.equal(a.passed, b.passed);
  });
});
