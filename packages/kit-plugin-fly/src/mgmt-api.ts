/**
 * Fly.io Management API client.
 *
 * Fly's app-secret surface is the GraphQL endpoint at
 * https://api.fly.io/graphql (flyctl talks to the same one). The Machines
 * REST API at https://api.machines.dev/v1 is read-mostly and used here
 * for machine introspection only.
 *
 * Auth: `FLY_API_TOKEN` env var (fly auth token).
 */

const DEFAULT_GRAPHQL_URL = "https://api.fly.io/graphql";
const DEFAULT_MACHINES_URL = "https://api.machines.dev/v1";

function assertNotReadOnly(operation: string): void {
  const v = process.env.KIT_READ_ONLY;
  if (v === "1" || v === "true") {
    throw new Error(`read-only mode active — refusing "${operation}"`);
  }
}

export interface MgmtClientConfig {
  graphqlUrl?: string;
  machinesUrl?: string;
  token?: string;
}

export interface MgmtClient {
  graphqlUrl: string;
  machinesUrl: string;
  headers: HeadersInit;
}

export function makeClient(cfg: MgmtClientConfig = {}): MgmtClient {
  const token = cfg.token ?? process.env.FLY_API_TOKEN;
  if (!token) {
    throw new Error(
      "FLY_API_TOKEN not set — run `fly auth token` to fetch one",
    );
  }
  return {
    graphqlUrl: cfg.graphqlUrl ?? DEFAULT_GRAPHQL_URL,
    machinesUrl: cfg.machinesUrl ?? DEFAULT_MACHINES_URL,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "sandstream-kit-plugin-fly",
    },
  };
}

async function gql<T>(client: MgmtClient, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(client.graphqlUrl, {
    method: "POST",
    headers: client.headers,
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Fly GraphQL returned ${res.status}: ${await safeText(res)}`);
  }
  const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors && body.errors.length) {
    throw new Error(`Fly GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  if (!body.data) {
    throw new Error("Fly GraphQL returned no data");
  }
  return body.data;
}

export interface AppSecretSummary {
  name: string;
  digest: string;
  createdAt: string;
}

export async function listAppSecrets(
  client: MgmtClient,
  appName: string,
): Promise<AppSecretSummary[]> {
  const data = await gql<{ app: { secrets: AppSecretSummary[] } }>(
    client,
    `query AppSecrets($appName: String!) {
      app(name: $appName) {
        secrets { name digest createdAt }
      }
    }`,
    { appName },
  );
  return data.app?.secrets ?? [];
}

export interface SetSecretsResult {
  release: { id: string; version: number };
}

export async function setAppSecrets(
  client: MgmtClient,
  appName: string,
  secrets: Record<string, string>,
): Promise<SetSecretsResult> {
  assertNotReadOnly("fly/setAppSecrets");
  const entries = Object.entries(secrets).map(([key, value]) => ({ key, value }));
  const data = await gql<{ setSecrets: SetSecretsResult }>(
    client,
    `mutation SetSecrets($input: SetSecretsInput!) {
      setSecrets(input: $input) {
        release { id version }
      }
    }`,
    { input: { appId: appName, secrets: entries } },
  );
  return data.setSecrets;
}

export async function unsetAppSecrets(
  client: MgmtClient,
  appName: string,
  keys: string[],
): Promise<SetSecretsResult> {
  assertNotReadOnly("fly/unsetAppSecrets");
  const data = await gql<{ unsetSecrets: SetSecretsResult }>(
    client,
    `mutation UnsetSecrets($input: UnsetSecretsInput!) {
      unsetSecrets(input: $input) {
        release { id version }
      }
    }`,
    { input: { appId: appName, keys } },
  );
  return data.unsetSecrets;
}

export interface MachineSummary {
  id: string;
  name: string;
  state: string;
  region: string;
}

export async function listMachines(
  client: MgmtClient,
  appName: string,
): Promise<MachineSummary[]> {
  const res = await fetch(`${client.machinesUrl}/apps/${encodeURIComponent(appName)}/machines`, {
    headers: client.headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`GET /apps/${appName}/machines returned ${res.status}: ${await safeText(res)}`);
  }
  return (await res.json()) as MachineSummary[];
}

async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 200);
  } catch {
    return "<no body>";
  }
}
