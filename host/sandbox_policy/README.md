# SuperClaw Sandbox Policy

Decides what the native Windows sandbox boundary is supposed to be. It reads the versioned policy
descriptors in `shared/contracts`, produces plans and verdicts, and returns them. Nothing here applies
anything: no broker call, no Win32 call, no security descriptor or WFP filter written. Applying a plan
is the isolation broker's job (`host/native_isolation_broker`).

- **Owner:** native isolation (Sandbox lifecycle).
- **Contracts:** the ACL policy descriptor (`shared/contracts/src/acl-policy-descriptor.ts`) and the
  egress policy descriptor and plan (`egress-policy-descriptor.ts`, `egress-policy-plan.ts`), consumed
  through the generated `contracts` package.
- **Allowed dependencies:** `pydantic` and `superclaw-contracts` only. No pywin32 and no dependency on
  `sandbox_manager`: a planner that could reach Win32 would sooner or later be asked to.
- **Consumers:** `sandbox_manager.broker_client.policy` (ACL plan),
  `sandbox_manager.broker_client.egress_wfp` (egress plan), and the isolation report producer (egress
  descriptor label and boundary state).
- **Platform:** any; Python ≥ 3.11. These are data transforms, tested on any host.

## Modules

| Module | What it does |
| --- | --- |
| `acl_descriptors` | Loads and validates the versioned ACL policy descriptor; holds the refusal type the planner raises. |
| `acl_plan` | Resolves the descriptor against one live workspace root set into the security descriptor each root must have (`plan_acl_policy`). |
| `acl_drift` | Compares a plan against a supplied readback and returns a verdict with findings (`check_acl_policy_drift`). No product path calls it today; the launcher's own DACL readback is what the product uses. |
| `egress_descriptors` | Loads and validates the egress policy descriptor; answers a tier's disposition, which loopback endpoint owns a port, the descriptor's version label and boundary state. |
| `egress_plan` | Resolves the egress descriptor against an owner's tier account SIDs and host evidence into an `EgressPolicyPlan`: every WFP object that should exist and every one of ours that should not. |

The ACL descriptor is keyed by **policy class** (`managed_default`, `user_granted_rw`,
`user_granted_ro`) and managed root scope, never by a literal path, so a second workspace root is a new
plan member rather than a new descriptor to review. The egress descriptor is keyed by rule class and
tier in the same way.

## What is deliberately not here

- **No apply.** A plan is a statement of intent.
- **No path resolution.** A plan names roots by `root_id` and placeholders by root-relative path;
  turning them into filesystem paths is `sandbox_manager.native_isolation`'s job, and the broker opens
  roots by handle itself.
- **No claim about enforcement.** A clean drift report says the readback matched the plan, not that the
  boundary held or that containment or egress is in place.
- **Per-tier subtrees and tier openings are checked only against supplied observations.** `acl_drift`
  compares each planned `tier_subtrees` entry with `tier_subtree_observations` on the same
  `managed_root_scope` and `tier`, and each `tier_openings` entry (today the channel tier's `inbox`,
  `outbox` and `agents`) with `tier_opening_observations` by `(tier, relative_path)`. This package never
  reads them from disk.
- **The shipped egress descriptor is permissive.** `egress_plan` refuses a plan that installs rules
  unless the caller's evidence shows the filtering engine running, the host's dynamic port range read and
  free of declared service ports, and no other sublayer at our weight. The shipped plan installs none, so
  v2.0 enforces no network egress.

## Tests

```powershell
uv run --directory host\sandbox_policy pytest
```

`tests/test_acl_plan.py::test_a_second_root_is_a_new_member_not_a_new_descriptor` and
`tests/test_egress_plan.py` hold the keyed-by-class property.
