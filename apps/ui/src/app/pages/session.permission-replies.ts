// confirm_file_protection, automation_create and automation_remove ask with `always: []`, so an
// "always" reply is remembered for nothing and acts like "Once". The engine also keeps "always"
// approvals per workspace, not per session, so the tool cannot honour the
// button by listing paths. Offer only the reject / once replies for them (#3661, problem 16).
const NO_ALLOW_FOR_SESSION = new Set(["confirm_file_protection", "automation_create", "automation_remove"]);

export function offersAllowForSession(permission: string | undefined): boolean {
  return !permission || !NO_ALLOW_FOR_SESSION.has(permission);
}
