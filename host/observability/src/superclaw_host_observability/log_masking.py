"""URL secret-redaction for log output, shared by Windows-host services.

Single source of truth: service-local copies of these regexes diverged once
(privacy_manager's variant missed userinfo-without-password and substring
param names like access_token). Do not fork this function.
"""
import re

# Userinfo: ":password" optional so "scheme://token@host" is also caught.
_URL_USERINFO_RE = re.compile(
    r"([A-Za-z][A-Za-z0-9+\-.]*://)([^\s/@:]*(?::[^\s/@]*)?)(@[^\s/]+)"
)

# Substring match on the param name, in query string or fragment.
_URL_SENSITIVE_QUERY_RE = re.compile(
    r"([?&#][^=&#\s]*(?:key|token|secret|pass|auth|sig|cred|jwt|bearer)[^=&#\s]*=)[^&#\s]+",
    re.IGNORECASE,
)


def mask_url_for_log(url: str) -> str:
    """Strip userinfo and credential-bearing query/fragment params from a URL."""
    masked = _URL_USERINFO_RE.sub(r"\1<redacted>\3", url)
    return _URL_SENSITIVE_QUERY_RE.sub(r"\1<redacted>", masked)