# Team management

There is no team management API in kit. Earlier versions of this page documented
functions such as `createTeam` and `getTeam`; they do not exist in the codebase.

## `kit team`

`kit team` is an `experimental` command and is **not implemented**. No team backend
exists, so:

- `kit team create`, `kit team invite`, `kit team members list` and
  `kit team member remove` print an explanation and exit 1 without changing anything;
- `kit team audit log` prints an empty log.

The command refuses rather than reporting a success that did not happen.

## Where role-based access actually lives

Role-based access control ships as part of the signed org policy, not as a team
service. The `[rbac]` table inside `.kit-policy.toml` maps subject identities
(`kid_...`) to roles and roles to permissions. It is covered by the same org
signature as the rest of the policy and is enforced offline, with no network call at
decision time (`src/rbac/`).

- Distribute and verify it with `kit policy sign`, `kit policy pull` and
  `kit policy verify`.
- See [CONTROL_PLANE.md](./CONTROL_PLANE.md) for the control-plane artefacts and how
  `kit doctor` reports RBAC posture.
- For the local audit trail use `kit audit` (see [COMMANDS.md](./COMMANDS.md#governance)).
