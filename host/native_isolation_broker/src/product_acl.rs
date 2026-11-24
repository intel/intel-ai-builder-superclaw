//! Product-facing workspace authorization revoke.
//!
//! Recording an authorization and applying an ACL plan used to live here too, behind `apply_acl_wire`, and
//! were reachable from the CLI. Both are now inside `provision_session`, which is the only place in the
//! product that turns a plan into a DACL write and the only place that can authenticate the owner it is
//! writing on behalf of. What is left is the one operation that needs no payload and grants no authority.

use crate::workspace_grant::revoke_workspace_authorization as revoke_grants;
use std::io;

pub fn revoke_workspace_authorization(owner_sid: &str) -> io::Result<()> {
    revoke_grants(owner_sid)
}
