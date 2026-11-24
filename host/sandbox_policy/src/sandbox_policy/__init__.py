"""L1 sandbox policy: what the boundary is supposed to be.

This package plans and checks. It does not apply. Every module here is a data
transform over the contracts in ``shared/contracts``, so nothing in it touches
Win32, calls the isolation broker, or writes a security descriptor.
"""

from sandbox_policy.acl_descriptors import (
    ACL_POLICY_CONTRACT_VERSION,
    ACL_POLICY_VERSION,
    AclPolicyRefusalError,
    RefusalItem,
    descriptor_data,
    managed_root_policy,
    workspace_root_policy,
)
from sandbox_policy.acl_drift import check_acl_policy_drift
from sandbox_policy.acl_plan import plan_acl_policy

__all__ = [
    "ACL_POLICY_CONTRACT_VERSION",
    "ACL_POLICY_VERSION",
    "AclPolicyRefusalError",
    "RefusalItem",
    "check_acl_policy_drift",
    "descriptor_data",
    "managed_root_policy",
    "plan_acl_policy",
    "workspace_root_policy",
]
