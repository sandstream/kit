import { z } from "zod";

/** The `[context]` section: the account and project each CLI must be pointed at. Unknown keys pass through and are reported by `kit context check`. */
export const ContextSchema = z
  .object({
    gcloud: z
      .object({
        account: z.string().optional(),
        project: z.union([z.string(), z.array(z.string())]).optional(),
        config: z.string().optional(),
        region: z.string().optional(),
      })
      .passthrough()
      .optional(),
    vercel: z
      .object({
        team: z.string().optional(),
        project: z.string().optional(),
        user: z.string().optional(),
      })
      .passthrough()
      .optional(),
    github: z
      .object({
        org: z.string().optional(),
        remote: z.string().optional(),
        user: z.string().optional(),
      })
      .passthrough()
      .optional(),
    convex: z.object({ account: z.string().optional() }).passthrough().optional(),
    gitlab: z
      .object({ group: z.string().optional(), remote: z.string().optional() })
      .passthrough()
      .optional(),
    bitbucket: z
      .object({ workspace: z.string().optional(), remote: z.string().optional() })
      .passthrough()
      .optional(),
    ssh: z
      .object({
        identity: z.string().optional(),
        fingerprint: z.string().optional(),
        host_alias: z.string().optional(),
      })
      .passthrough()
      .optional(),
    git: z.object({ email: z.string().optional() }).passthrough().optional(),
    npm: z.object({ registry: z.string().optional() }).passthrough().optional(),
    keycloak: z.object({ realm: z.string().optional() }).passthrough().optional(),
    auth0: z.object({ tenant: z.string().optional() }).passthrough().optional(),
    clerk: z.object({ env: z.string().optional() }).passthrough().optional(),
  })
  .passthrough()
  .optional();
