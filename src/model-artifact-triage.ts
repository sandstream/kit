/**
 * kit — untrusted AI-artifact triage (model weights / eval datasets).
 *
 * A locally-run model file is an UNTRUSTED artifact like any dependency: the
 * OpenAI×HuggingFace eval-escape (2026-07) entered via a malicious dataset with
 * code-execution in the data pipeline, and llama.cpp GGUF loaders have shipped
 * heap-overflow RCEs on crafted `.gguf` files. "Runs locally" is not "runs safely".
 * This is the deterministic, zero-LLM triage of a model/dataset artifact BEFORE you
 * load it into an inference runtime.
 *
 * Pure + deterministic: classification is by file extension + optional size, with an
 * honest UNKNOWN when the format can't be classified. Confidence is "high" only for
 * the pickle/deserialization family (documented arbitrary-code-execution on load);
 * everything else is "heuristic" advisory. No network, no LLM.
 */
import { basename, extname } from "node:path";

export type ArtifactFormatRisk = "code-exec" | "loader-hardening" | "data-only" | "unknown";

export interface ModelArtifactFinding {
  label: string;
  rationale: string;
  confidence: "high" | "heuristic";
}

export interface ModelArtifactTriage {
  artifact: string;
  ext: string;
  formatRisk: ArtifactFormatRisk;
  findings: ModelArtifactFinding[];
  /** No high-confidence (code-exec-on-load) finding. Loader-hardening/unknown stay advisory. */
  passed: boolean;
}

/**
 * Deserialization/code-exec-on-load family: loading these can run arbitrary code
 * (Python `pickle` and formats that wrap it). The single high-confidence class.
 */
const CODE_EXEC_EXTS = new Set([
  ".pkl",
  ".pickle",
  ".pt",
  ".pth",
  ".bin",
  ".ckpt",
  ".joblib",
  ".dill",
  ".npy",
  ".npz",
  ".h5",
  ".pb",
  ".model",
]);

/** Formats with no pickle exec but whose LOADERS have had memory-safety CVEs (verify source + integrity). */
const LOADER_HARDENING_EXTS = new Set([".gguf", ".ggml", ".onnx"]);

/** Formats designed to carry data only (no code exec) — still untrusted DATA, verify integrity/provenance. */
const DATA_ONLY_EXTS = new Set([
  ".safetensors",
  ".parquet",
  ".arrow",
  ".jsonl",
  ".csv",
  ".tfrecord",
]);

/**
 * Triage a single model/dataset artifact by name (and optional size / known-good hash
 * state). Pure — the caller supplies the facts; this never touches disk or network.
 */
export function triageModelArtifact(
  fileName: string,
  opts: { sizeBytes?: number; provenanceVerified?: boolean } = {},
): ModelArtifactTriage {
  const artifact = basename(fileName);
  const ext = extname(artifact).toLowerCase();
  const findings: ModelArtifactFinding[] = [];

  let formatRisk: ArtifactFormatRisk;
  if (CODE_EXEC_EXTS.has(ext)) {
    formatRisk = "code-exec";
    findings.push({
      label: `code-execution-on-load format (${ext})`,
      rationale:
        "This format can execute arbitrary code when deserialized (Python pickle family). Do not load untrusted files; prefer .safetensors, or load in a sandbox with weights-only/trusted-source guarantees.",
      confidence: "high",
    });
  } else if (LOADER_HARDENING_EXTS.has(ext)) {
    formatRisk = "loader-hardening";
    findings.push({
      label: `loader-hardening-sensitive format (${ext})`,
      rationale:
        "No pickle code-exec, but the loaders for this format have shipped memory-safety CVEs (e.g. crafted .gguf → heap overflow in llama.cpp). Verify the source and integrity, and keep the runtime patched.",
      confidence: "heuristic",
    });
  } else if (DATA_ONLY_EXTS.has(ext)) {
    formatRisk = "data-only";
    findings.push({
      label: `data-only format (${ext})`,
      rationale:
        "Designed to carry data without code execution — but it is still UNTRUSTED input. A malicious dataset can exploit the pipeline that processes it (the OpenAI eval-escape entry vector). Verify integrity/provenance and process in a sandbox.",
      confidence: "heuristic",
    });
  } else {
    formatRisk = "unknown";
    findings.push({
      label: ext ? `unclassified artifact format (${ext})` : "no file extension",
      rationale:
        "Cannot classify this artifact's format, so its load-time behavior is unknown. Treat as untrusted: identify the format, prefer a code-exec-free container, and load in a sandbox.",
      confidence: "heuristic",
    });
  }

  if (opts.provenanceVerified !== true) {
    findings.push({
      label: "unverified provenance",
      rationale:
        "No verified source/signature/known-good hash for this artifact. 'Expert-approved' or 'popular' is not 'verified on your machine' — pin and verify a hash before loading.",
      confidence: "heuristic",
    });
  }

  if (opts.sizeBytes === 0) {
    findings.push({
      label: "zero-byte artifact",
      rationale: "The file is empty — a truncated/failed download or a placeholder; do not load.",
      confidence: "heuristic",
    });
  }

  const passed = !findings.some((f) => f.confidence === "high");
  return { artifact, ext, formatRisk, findings, passed };
}
