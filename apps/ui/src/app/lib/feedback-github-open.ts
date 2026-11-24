/**
 * GitHub issue draft URLs require a signed-in session. Route through /login with
 * return_to so unsigned users are prompted to sign in (or create an account)
 * before landing on the prefilled new-issue form.
 */
export function githubSignInUrlForIssueDraft(issueDraftUrl: string): string {
  const trimmed = issueDraftUrl.trim();
  if (!trimmed) {
    return trimmed;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed;
  }

  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") {
    return trimmed;
  }

  if (!parsed.pathname.endsWith("/issues/new")) {
    return trimmed;
  }

  const login = new URL("/login", parsed.origin);
  login.searchParams.set("return_to", `${parsed.pathname}${parsed.search}`);
  return login.toString();
}
