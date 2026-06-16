import { randomUUID } from "crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

export type VerificationStatus =
  | "pending"
  | "verified"
  | "rejected"
  | "expired";

export type VerificationStep =
  | "github"
  | "email"
  | "cla"
  | "review"
  | "publisher";

export interface VerificationToken {
  token: string;
  type: "email" | "github";
  authorId: string;
  expiresAt: string;
  usedAt?: string;
}

export interface GitHubVerification {
  githubId: string;
  githubLogin: string;
  githubName?: string;
  githubAvatarUrl?: string;
  verifiedAt: string;
}

export interface EmailVerification {
  email: string;
  verifiedAt: string;
  domain: string;
}

export interface CLASignature {
  version: string;
  signedAt: string;
  ipAddress?: string;
}

export interface VerificationRecord {
  authorId: string;
  status: VerificationStatus;
  steps: VerificationStep[];
  completedSteps: VerificationStep[];
  github?: GitHubVerification;
  email?: EmailVerification;
  cla?: CLASignature;
  publisherApprovedAt?: string;
  publisherApprovedBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface VerificationResult {
  success: boolean;
  step: VerificationStep;
  message: string;
  nextStep?: VerificationStep;
  record?: VerificationRecord;
}

// ─── AuthorVerificationSystem ─────────────────────────────────────────────────

export class AuthorVerificationSystem {
  private records: Map<string, VerificationRecord> = new Map();
  private tokens: Map<string, VerificationToken> = new Map();

  // ─── Record lifecycle ──────────────────────────────────────────────────────

  startVerification(authorId: string): VerificationRecord {
    const existing = this.records.get(authorId);
    if (existing && existing.status !== "expired") return existing;

    const record: VerificationRecord = {
      authorId,
      status: "pending",
      steps: ["github", "email", "cla"],
      completedSteps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.records.set(authorId, record);
    return record;
  }

  getVerification(authorId: string): VerificationRecord | null {
    return this.records.get(authorId) || null;
  }

  // ─── GitHub verification ───────────────────────────────────────────────────

  generateGitHubState(authorId: string): string {
    const state = `${authorId}:${randomUUID()}`;
    return Buffer.from(state).toString("base64");
  }

  parseGitHubState(state: string): { authorId: string } | null {
    try {
      const decoded = Buffer.from(state, "base64").toString("utf-8");
      // Must have format "{authorId}:{uuid}" — colon present with non-empty parts
      const colonIdx = decoded.indexOf(":");
      if (colonIdx <= 0) return null;
      const authorId = decoded.substring(0, colonIdx);
      const nonce = decoded.substring(colonIdx + 1);
      if (!authorId || !nonce) return null;
      // Nonce must be a valid UUID
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidPattern.test(nonce)) return null;
      return { authorId };
    } catch {
      return null;
    }
  }

  async completeGitHubVerification(
    authorId: string,
    githubData: {
      id: string;
      login: string;
      name?: string;
      avatar_url?: string;
    },
  ): Promise<VerificationResult> {
    let record = this.records.get(authorId);
    if (!record) {
      record = this.startVerification(authorId);
    }

    // Check if github ID is already used by another author
    for (const [existingId, existingRecord] of this.records) {
      if (
        existingId !== authorId &&
        existingRecord.github?.githubId === githubData.id
      ) {
        return {
          success: false,
          step: "github",
          message: `GitHub account ${githubData.login} is already linked to another author`,
        };
      }
    }

    const github: GitHubVerification = {
      githubId: githubData.id,
      githubLogin: githubData.login,
      githubName: githubData.name,
      githubAvatarUrl: githubData.avatar_url,
      verifiedAt: new Date().toISOString(),
    };

    const updated = this.completeStep(authorId, "github", { github });
    const nextStep = this.getNextStep(updated);

    return {
      success: true,
      step: "github",
      message: `GitHub account @${githubData.login} verified`,
      nextStep: nextStep || undefined,
      record: updated,
    };
  }

  // ─── Email verification ────────────────────────────────────────────────────

  generateEmailToken(authorId: string, email: string): string {
    const token: VerificationToken = {
      token: randomUUID(),
      type: "email",
      authorId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };

    this.tokens.set(token.token, token);
    return token.token;
  }

  async verifyEmailToken(
    token: string,
    email: string,
  ): Promise<VerificationResult> {
    const tokenRecord = this.tokens.get(token);
    if (!tokenRecord) {
      return {
        success: false,
        step: "email",
        message: "Invalid or expired verification token",
      };
    }

    if (tokenRecord.type !== "email") {
      return {
        success: false,
        step: "email",
        message: "Token is not an email verification token",
      };
    }

    if (new Date(tokenRecord.expiresAt) < new Date()) {
      return {
        success: false,
        step: "email",
        message: "Verification token has expired",
      };
    }

    if (tokenRecord.usedAt) {
      return {
        success: false,
        step: "email",
        message: "Verification token has already been used",
      };
    }

    // Mark token as used
    tokenRecord.usedAt = new Date().toISOString();

    const domain = email.split("@")[1] || "";
    const emailVerification: EmailVerification = {
      email,
      domain,
      verifiedAt: new Date().toISOString(),
    };

    const record = this.completeStep(tokenRecord.authorId, "email", {
      email: emailVerification,
    });
    const nextStep = this.getNextStep(record);

    return {
      success: true,
      step: "email",
      message: `Email ${email} verified`,
      nextStep: nextStep || undefined,
      record,
    };
  }

  // ─── CLA signing ─────────────────────────────────────────────────────────

  async signCLA(
    authorId: string,
    claVersion: string,
    ipAddress?: string,
  ): Promise<VerificationResult> {
    const record = this.records.get(authorId);
    if (!record) {
      return {
        success: false,
        step: "cla",
        message: "Verification not started",
      };
    }

    const cla: CLASignature = {
      version: claVersion,
      signedAt: new Date().toISOString(),
      ipAddress,
    };

    const updated = this.completeStep(authorId, "cla", { cla });
    const nextStep = this.getNextStep(updated);

    // Check if all required steps complete — auto-verify
    if (this.isFullyVerified(updated)) {
      updated.status = "verified";
      updated.updatedAt = new Date().toISOString();
    }

    return {
      success: true,
      step: "cla",
      message: `CLA version ${claVersion} signed`,
      nextStep: nextStep || undefined,
      record: updated,
    };
  }

  // ─── Publisher verification ────────────────────────────────────────────────

  async approvePublisher(
    authorId: string,
    approvedBy: string,
  ): Promise<VerificationResult> {
    const record = this.records.get(authorId);
    if (!record) {
      return {
        success: false,
        step: "publisher",
        message: "No verification record found",
      };
    }

    if (record.status !== "verified") {
      return {
        success: false,
        step: "publisher",
        message: "Author must complete basic verification before publisher approval",
      };
    }

    const updated = this.completeStep(authorId, "publisher", {
      publisherApprovedAt: new Date().toISOString(),
      publisherApprovedBy: approvedBy,
    });

    return {
      success: true,
      step: "publisher",
      message: `Author approved as verified publisher by ${approvedBy}`,
      record: updated,
    };
  }

  // ─── Status helpers ────────────────────────────────────────────────────────

  isStepComplete(authorId: string, step: VerificationStep): boolean {
    const record = this.records.get(authorId);
    return record?.completedSteps.includes(step) || false;
  }

  isFullyVerified(record: VerificationRecord): boolean {
    return record.steps.every((step) => record.completedSteps.includes(step));
  }

  isPublisherVerified(authorId: string): boolean {
    const record = this.records.get(authorId);
    return record?.completedSteps.includes("publisher") || false;
  }

  getNextStep(record: VerificationRecord): VerificationStep | null {
    for (const step of record.steps) {
      if (!record.completedSteps.includes(step)) {
        return step;
      }
    }
    return null;
  }

  getVerificationProgress(authorId: string): {
    total: number;
    completed: number;
    percent: number;
    nextStep: VerificationStep | null;
  } {
    const record = this.records.get(authorId);
    if (!record) return { total: 0, completed: 0, percent: 0, nextStep: null };

    const total = record.steps.length;
    const completed = record.completedSteps.length;
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

    return { total, completed, percent, nextStep: this.getNextStep(record) };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private completeStep(
    authorId: string,
    step: VerificationStep,
    extraData: Partial<VerificationRecord>,
  ): VerificationRecord {
    const record = this.records.get(authorId)!;
    const updatedRecord: VerificationRecord = {
      ...record,
      ...extraData,
      completedSteps: record.completedSteps.includes(step)
        ? record.completedSteps
        : [...record.completedSteps, step],
      updatedAt: new Date().toISOString(),
    };
    this.records.set(authorId, updatedRecord);
    return updatedRecord;
  }

  // ─── Test helpers ──────────────────────────────────────────────────────────

  setRecordsCache(records: VerificationRecord[]): void {
    this.records.clear();
    for (const record of records) {
      this.records.set(record.authorId, record);
    }
  }

  getTokensCache(): Map<string, VerificationToken> {
    return this.tokens;
  }
}
