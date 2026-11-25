import type { SecretStatus } from "./check-secrets.js";

type ProbeResult = Pick<SecretStatus, "available" | "detail" | "state" | "unverified">;

export async function verifyVercelToken(token: string, offline: boolean): Promise<ProbeResult> {
  const unavailable = { available: false, unverified: true } as const;
  if (offline)
    return { ...unavailable, detail: "Unverified: air-gap mode disables the Vercel probe" };
  try {
    const response = await fetch("https://api.vercel.com/v2/user", {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    await response.body?.cancel();
    if (response.status === 200) return { available: true, detail: "Vercel accepted the token" };
    if (response.status === 401 || response.status === 403)
      return { available: false, state: "invalid", detail: "Vercel refused the token" };
    return { ...unavailable, detail: `Unverified: Vercel probe returned HTTP ${response.status}` };
  } catch {
    return { ...unavailable, detail: "Unverified: Vercel probe did not complete" };
  }
}
