---
status: stable
authority: stable-contract-interpretation
last_verified: 2026-04-30
source_paths:
  - src/contracts/trait-module.ts
  - src/core/trait-module-loader.ts
  - src/contracts/methodology-skill.ts
  - tests/core/trait-module-loader.spec.ts
scope: TraitModule id major version, manifest package version, coexistence, duplicate rejection, deprecation, and migration policy.
---

# TraitModule Versioning Contract

## 1. Two version axes

TraitModule uses two separate version axes:

| Axis | Field | Meaning |
| --- | --- | --- |
| Contract-major identity | `TraitModuleId` suffix `.vN` | Stable compatibility boundary for admission/runtime semantics. |
| Manifest package version | `TraitModuleManifest.version` | Implementation/package version of one manifest under that contract-major id. |

Example: `trait.methodology.agent-methodology-origin.v1` with manifest version
`1.0.0` means contract-major v1, package version 1.0.0. A future
`trait.methodology.agent-methodology-origin.v2` is a different TraitModule id;
it is not an implicit upgrade of v1.

## 2. Registry coexistence

The TraitModule registry MUST reject duplicate `(id, version)` pairs. This is
implemented by the registry key `id@version`.

Allowed:

- `trait.foo.bar.v1@1.0.0`
- `trait.foo.bar.v2@2.0.0`

Rejected:

- two manifests both declaring `trait.foo.bar.v1@1.0.0`

Coexisting major ids do not imply automatic migration. Admission must consume the
exact id requested by the plan or operator configuration.

## 3. Deprecation

A TraitModule id remains loadable until a contract document or migration record
marks it deprecated. Deprecation is advisory unless a specific loader policy or
operator lockfile opts into fail-closed rejection of deprecated ids.

The current canonical methodology id is:

- `trait.methodology.agent-methodology-origin.v1`

No v2 methodology module is active as of 2026-04-30.

## 4. Migration policy

A v1→v2 migration requires an explicit migration entry with:

1. old id,
2. new id,
3. compatibility status,
4. operator opt-in or automatic migration rule,
5. behavior when both ids are requested,
6. rollback/deprecation note.

Without such a record, loaders and admission code MUST NOT rewrite v1 requests to
v2 or silently prefer v2.

## 5. Loader invariants

- `traitModuleRegistryKey(manifest)` is the duplicate-detection key.
- `traitModuleFamilyId(id)` removes only the final `.vN` suffix.
- `traitModuleMajorVersion(id)` returns the numeric contract-major version.
- `isTraitModuleMajorSuccessor(previous, next)` is true only when both ids share
  the same family and `next` has a larger major version.
