/**
 * Shared primitives for the v1.2 capability-gating wire contracts.
 *
 * Wire data only. `CapabilityGrade` is retained as opaque Bundle metadata for
 * v1 contract compatibility. It is a pattern-validated string, not an enum, so
 * an unknown-but-well-formed value remains safe to pass through.
 */
import { z } from "zod";

/** Kebab-case opaque Bundle metadata token. */
export const CapabilityGradeSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);
export type CapabilityGrade = z.infer<typeof CapabilityGradeSchema>;

/** Monotonic, non-negative integer revision. */
export const RevisionSchema = z.number().int().nonnegative();

/** Validated ISO-8601 timestamp string. */
export const IsoTimestampSchema = z.iso.datetime();

/** Lowercase hex SHA-256 digest (64 chars). Shared by manifest/emergency/snapshot evidence. */
export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/** Canonical cross-service operation id: `<service>:<token>` with service in {hub,lrm,sm}. */
export const OperationIdSchema = z.string().regex(/^(hub|lrm|sm):[A-Za-z0-9][A-Za-z0-9._-]*$/);

export const HubOperationIdSchema = z.string().regex(/^hub:[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const LrmOperationIdSchema = z.string().regex(/^lrm:[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const SmOperationIdSchema = z.string().regex(/^sm:[A-Za-z0-9][A-Za-z0-9._-]*$/);

/** Contract compatibility version: monotonic integer >= 1. */
export const ContractVersionSchema = z.number().int().min(1);

export const PrimaryBundleContractVersionSchema = z.literal(1);
export const ModelBindingActivationContractVersionSchema = z.literal(1);
export const AppCapabilityProfileContractVersionSchema = z.literal(1);
export const AppReadinessContractVersionSchema = z.literal(1);

/** Secret-free error envelope for control-plane status and UI projections. */
export const SafeErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
  })
  .strict();
export type SafeError = z.infer<typeof SafeErrorSchema>;

/** Current frozen contract version per family (all at 1). */
export const CONTRACT_VERSIONS = {
  modelBindingActivation: 1,
  modelBundle: 1,
  primaryBundle: 1,
  appCapabilityProfile: 1,
  featureManifest: 2,
  routeMode: 1,
  embedding: 1,
} as const;

export type ContractFamily = keyof typeof CONTRACT_VERSIONS;

/** Explicit supported-set membership check. Fails closed: anything not listed is unsupported. */
export function isSupportedContractVersion(
  _family: ContractFamily,
  version: number,
  supported: readonly number[],
): boolean {
  return supported.includes(version);
}
