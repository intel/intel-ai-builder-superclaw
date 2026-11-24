"""What the relay does with each CDP command a client sends to the host Edge.

Pure decisions, except the upload check, which reads the filesystem. The lists come from the
contract (`HOST_MCP_RULES["cdp"]`); this module adds only the per-method rules around them.
"""

from __future__ import annotations

import base64
import ipaddress
import json
import re
import stat
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal
from urllib.parse import unquote

from contracts.host_mcp_api_data import HOST_MCP_RULES

# Chromium parses a CDP id as a signed 32-bit int and answers 2**31 with an id-less error, so the
# relay's own ids are the top half of that range and a client may use only the bottom half.
RESERVED_ID_BASE = 2**30
BLOCKED_ERROR_CODE = -32000
BLOCKED_MESSAGE = "Blocked by SuperClaw host browser policy"

OriginDecision = Literal["allow", "ask", "deny"]

_DOWNLOAD_METHODS = frozenset({"Browser.setDownloadBehavior", "Page.setDownloadBehavior"})
# Every client-supplied destination: a navigation, a new target, or a paused request sent elsewhere.
_DESTINATION_METHODS = frozenset({"Page.navigate", "Target.createTarget", "Fetch.continueRequest"})
# Responses the client writes itself, whose `Location` header would send the browser elsewhere.
_RESPONSE_METHODS = frozenset({"Fetch.fulfillRequest", "Fetch.continueResponse"})
# Blocked here even though the contract allows their domain: `loadNetworkResource` fetches any URL
# outside page navigation, and `continueInterceptedRequest` can rewrite the URL or answer with a raw
# response that redirects.
_RELAY_BLOCKED_METHODS = frozenset({"Network.loadNetworkResource", "Network.continueInterceptedRequest"})
_CONTEXT_PARAMS = frozenset({"disposeOnDetach"})
_PASTE_VIRTUAL_KEY, _INSERT_VIRTUAL_KEY = 86, 45
_CTRL, _META, _SHIFT = 2, 4, 8
_KEY_EVENT_NUMBER_CEILINGS = {"modifiers": 0xFFFF, "windowsVirtualKeyCode": 0xFF, "nativeVirtualKeyCode": 0xFF}
_UPLOAD_FILES_MAX = 64
_UPLOAD_PATH_MAX_CHARS = 4096
_UPLOAD_METHODS = frozenset({"DOM.setFileInputFiles", "Input.dispatchDragEvent", "Target.sendMessageToTarget"})
_HOST = re.compile(r"[a-z0-9._-]+")
# UTS #46 (what Chromium uses) and IDNA 2003 (Python's codec) map these differently, so the origin
# Python computes for a host with one of them may not be the host Edge visits.
_IDNA_DEVIATIONS = frozenset("\u00df\u03c2\u200c\u200d")
_SCHEME = re.compile(r"^([A-Za-z][A-Za-z0-9+.\-]*):")
_DEFAULT_PORTS = {"http": 80, "https": 443}
# The contract blocks `data` only for browser-initiated top-level navigations: a page Chromium itself
# lands on, or a request URL, with that scheme is not refused.
_NAVIGATION_ONLY_SCHEMES = frozenset({"data"})
# A reparse tag with this bit redirects the name (symlinks, junctions); cloud-file placeholders do not.
_NAME_SURROGATE_BIT = 0x20000000


@dataclass(frozen=True)
class CdpRules:
    allowed_domains: frozenset[str]
    blocked_methods: frozenset[str]
    blocked_schemes: frozenset[str]
    block_private_network: bool = True

    @classmethod
    def from_contract(cls) -> CdpRules:
        cdp = HOST_MCP_RULES["cdp"]
        return cls(
            allowed_domains=frozenset(cdp["allowed_cdp_domains"]),
            blocked_methods=frozenset(cdp["blocked_cdp_methods"]),
            blocked_schemes=frozenset(cdp["blocked_url_schemes"]),
            block_private_network=bool(cdp.get("block_private_network_destinations", True)),
        )

    @property
    def blocked_everywhere(self) -> frozenset[str]:
        """The schemes refused for request URLs and for pages Chromium lands on, not only navigations."""
        return self.blocked_schemes - _NAVIGATION_ONLY_SCHEMES


@dataclass(frozen=True)
class OriginPolicy:
    default: OriginDecision = "allow"
    allow: frozenset[str] = frozenset()
    deny: frozenset[str] = frozenset()

    def decide(self, origin: str) -> OriginDecision:
        if origin in self.deny:
            return "deny"
        if origin in self.allow:
            return "allow"
        return self.default


@dataclass(frozen=True)
class BrowserPolicy:
    downloads_dir: Path
    upload_roots: tuple[Path, ...]
    origins: OriginPolicy = field(default_factory=OriginPolicy)


@dataclass(frozen=True)
class Forward:
    """Send to the browser: as received when `message` is None, else the rewritten message."""

    message: dict[str, object] | None = None


@dataclass(frozen=True)
class Refuse:
    """Answer the client with the policy error. `fields` is what the audit may record."""

    event: str
    fields: dict[str, str]


@dataclass(frozen=True)
class AskOrigin:
    origin: str


@dataclass(frozen=True)
class ResolveHost:
    """Resolve `host`, then pass its addresses to `decide_resolved` to finish the decision."""

    method: str
    origin: str
    host: str


Decision = Forward | Refuse | AskOrigin | ResolveHost


class MalformedMessage(ValueError):
    pass


class UploadRefused(ValueError):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def parse_client_message(text: str) -> dict[str, object]:
    try:
        message = json.loads(text)
    except (ValueError, RecursionError) as error:
        raise MalformedMessage("not JSON") from error
    if not isinstance(message, dict):
        raise MalformedMessage("not an object")
    message_id = message.get("id")
    if type(message_id) is not int or not 0 <= message_id < RESERVED_ID_BASE:
        raise MalformedMessage("id")
    if not isinstance(message.get("method"), str):
        raise MalformedMessage("method")
    if "params" in message and not isinstance(message["params"], dict):
        raise MalformedMessage("params")
    if "sessionId" in message and not isinstance(message["sessionId"], str):
        raise MalformedMessage("sessionId")
    return message


def decision_reads_files(message: dict[str, object]) -> bool:
    """Whether `decide` may touch the filesystem for this message (upload path checks)."""
    return message["method"] in _UPLOAD_METHODS


def error_reply(message: dict[str, object]) -> dict[str, object]:
    reply: dict[str, object] = {"id": message["id"]}
    if "sessionId" in message:
        reply["sessionId"] = message["sessionId"]
    reply["error"] = {"code": BLOCKED_ERROR_CODE, "message": BLOCKED_MESSAGE}
    return reply


def decide(message: dict[str, object], rules: CdpRules, policy: BrowserPolicy) -> Decision:
    method = str(message["method"])
    params = message.get("params")
    params = params if isinstance(params, dict) else {}

    if method in _DOWNLOAD_METHODS:
        return Forward(_rewrite_download(message, method, params, policy.downloads_dir))

    domain, dot, _ = method.partition(".")
    if (
        not dot
        or domain not in rules.allowed_domains
        or method in rules.blocked_methods
        or method in _RELAY_BLOCKED_METHODS
    ):
        return Refuse("browser_cdp_blocked", {"method": method})

    if method in _DESTINATION_METHODS:
        url = params.get("url")
        if url is None and method == "Fetch.continueRequest":
            return Forward()
        if method == "Target.createTarget" and isinstance(url, str) and clean_url(url) == "":
            return Forward()
        return decide_destination(method, url, rules, policy.origins)
    if method in _RESPONSE_METHODS:
        return _decide_response_location(method, params, rules, policy.origins)
    if method == "Target.createBrowserContext" and set(params) - _CONTEXT_PARAMS:
        return Refuse("browser_cdp_blocked", {"method": method, "reason": "context_parameter"})
    if method == "Input.dispatchKeyEvent":
        reason = _key_event_refusal(params)
        if reason:
            return Refuse("browser_cdp_blocked", {"method": method, "reason": reason})
    if method == "DOM.setFileInputFiles":
        try:
            files = check_upload_paths(params.get("files"), policy.upload_roots)
        except UploadRefused as refused:
            return Refuse("browser_upload_refused", {"method": method, "reason": refused.reason})
        return Forward({**message, "params": {**params, "files": files}})
    data = params.get("data")
    if method == "Input.dispatchDragEvent" and isinstance(data, dict) and "files" in data:
        try:
            files = check_upload_paths(data["files"], policy.upload_roots)
        except UploadRefused as refused:
            return Refuse("browser_upload_refused", {"method": method, "reason": refused.reason})
        return Forward({**message, "params": {**params, "data": {**data, "files": files}}})
    if method == "Target.sendMessageToTarget":
        return _decide_wrapped(params, rules, policy)
    return Forward()


def _rewrite_download(
    message: dict[str, object], method: str, params: dict[str, object], downloads_dir: Path
) -> dict[str, object]:
    behavior = params.get("behavior")
    rewritten: dict[str, object]
    if behavior == "deny":
        rewritten = {"behavior": "deny"}
    elif behavior == "allowAndName" and method == "Browser.setDownloadBehavior":
        rewritten = {"behavior": "allowAndName", "downloadPath": str(downloads_dir)}
    else:
        rewritten = {"behavior": "allow", "downloadPath": str(downloads_dir)}
    for key in ("browserContextId", "eventsEnabled"):
        if key in params:
            rewritten[key] = params[key]
    return {**message, "params": rewritten}


def decide_destination(method: str, url: object, rules: CdpRules, origins: OriginPolicy) -> Decision:
    """The policy for any URL the client sends the browser to: scheme, private network, origin."""
    if not isinstance(url, str):
        return Refuse("browser_navigation_blocked", {"method": method, "scheme": "invalid"})
    verdict = classify_navigation(url, rules)
    if verdict.kind == "allow":
        return Forward()
    if verdict.kind == "block":
        return Refuse("browser_navigation_blocked", {"method": method, "scheme": verdict.value})
    origin = verdict.value
    if rules.block_private_network and origin not in origins.allow and origin not in origins.deny:
        host = origin_host(origin)
        if host == "localhost" or host.endswith(".localhost"):
            return _private_refusal(method, origin)
        try:
            literal = ipaddress.ip_address(host.strip("[]"))
        except ValueError:
            return ResolveHost(method, origin, host)
        if is_private_address(literal):
            return _private_refusal(method, origin)
    return _apply_origin_policy(method, origin, origins)


def decide_resolved(pending: ResolveHost, addresses: Sequence[str], origins: OriginPolicy) -> Decision:
    """Finish a navigation decision once its host has resolved. A host that did not resolve is refused."""
    parsed: list[ipaddress.IPv4Address | ipaddress.IPv6Address] = []
    for address in addresses:
        try:
            parsed.append(ipaddress.ip_address(address.partition("%")[0]))
        except ValueError:
            continue
    if not parsed:
        return Refuse(
            "browser_navigation_blocked", {"method": pending.method, "origin": pending.origin, "reason": "unresolved"}
        )
    if any(is_private_address(address) for address in parsed):
        return _private_refusal(pending.method, pending.origin)
    return _apply_origin_policy(pending.method, pending.origin, origins)


def _decide_response_location(
    method: str, params: dict[str, object], rules: CdpRules, origins: OriginPolicy
) -> Decision:
    headers = _response_headers(params)
    if headers is None:
        return Refuse("browser_navigation_blocked", {"method": method, "scheme": "invalid"})
    if any(name == "refresh" for name, _ in headers):
        return Refuse("browser_navigation_blocked", {"method": method, "reason": "refresh_header"})
    locations = [value for name, value in headers if name == "location"]
    if len(locations) > 1:
        return Refuse("browser_navigation_blocked", {"method": method, "reason": "location"})
    if not locations:
        return Forward()
    location = clean_url(locations[0])
    if url_scheme(location) is None:
        # A path on the same origin; `//host` and `/\host` would name another host.
        if location.startswith("/") and not location.startswith(("//", "/\\")):
            return Forward()
        return Refuse("browser_navigation_blocked", {"method": method, "reason": "location"})
    return decide_destination(method, location, rules, origins)


def _response_headers(params: dict[str, object]) -> list[tuple[str, str]] | None:
    """Every header in `responseHeaders` and `binaryResponseHeaders` as (trimmed lowercase name, value),
    or None if either is unreadable."""
    pairs: list[tuple[str, str]] = []
    headers = params.get("responseHeaders")
    if headers is not None:
        if not isinstance(headers, list):
            return None
        for header in headers:
            if not isinstance(header, dict) or not isinstance(header.get("name"), str):
                return None
            value = header.get("value")
            if not isinstance(value, str):
                return None
            pairs.append((header["name"].strip().lower(), value))
    binary = params.get("binaryResponseHeaders")
    if binary is not None:
        if not isinstance(binary, str):
            return None
        try:
            text = base64.b64decode(binary, validate=True).decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            return None
        for line in text.split("\0"):
            name, colon, value = line.partition(":")
            if colon:
                pairs.append((name.strip().lower(), value.strip()))
    return pairs


def _key_event_refusal(params: dict[str, object]) -> str | None:
    """Why a key event may not reach the page: an editing command, or a paste from the host clipboard.

    The numbers are bounded first: Chromium keeps only the low bits of a key code, so 65622 with Ctrl
    is VK_V by the time it reaches the page.
    """
    commands = params.get("commands")
    if commands is not None and commands != []:
        return "editing_command"
    numbers: dict[str, int] = {}
    for name, ceiling in _KEY_EVENT_NUMBER_CEILINGS.items():
        value = params.get(name, 0)
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or (isinstance(value, float) and not value.is_integer())
            or not 0 <= value <= ceiling
        ):
            return "malformed_key_event"
        numbers[name] = int(value)
    key, code = params.get("key", ""), params.get("code", "")
    if not isinstance(key, str) or not isinstance(code, str):
        return "malformed_key_event"
    key, code = key.lower(), code.lower()
    codes = {numbers["windowsVirtualKeyCode"], numbers["nativeVirtualKeyCode"]}
    modifiers = numbers["modifiers"]
    is_v = _PASTE_VIRTUAL_KEY in codes or key == "v" or code == "keyv"
    is_insert = _INSERT_VIRTUAL_KEY in codes or key == "insert" or code == "insert"
    if (is_v and modifiers & (_CTRL | _META)) or (is_insert and modifiers & _SHIFT) or "paste" in key or "paste" in code:
        return "clipboard_paste"
    return None


def is_private_address(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if isinstance(address, ipaddress.IPv6Address):
        if address.ipv4_mapped is not None:
            address = address.ipv4_mapped
        elif address.is_site_local:
            return True
    return (
        not address.is_global
        or address.is_multicast
        or address.is_loopback
        or address.is_link_local
        or address.is_unspecified
        or address.is_reserved
    )


def _private_refusal(method: str, origin: str) -> Refuse:
    return Refuse("browser_navigation_blocked", {"method": method, "origin": origin, "reason": "private_network"})


def _apply_origin_policy(method: str, origin: str, origins: OriginPolicy) -> Decision:
    decision = origins.decide(origin)
    if decision == "allow":
        return Forward()
    if decision == "deny":
        return Refuse("browser_navigation_blocked", {"method": method, "origin": origin})
    return AskOrigin(origin)


def _decide_wrapped(params: dict[str, object], rules: CdpRules, policy: BrowserPolicy) -> Decision:
    inner_text = params.get("message")
    method = "Target.sendMessageToTarget"
    if not isinstance(inner_text, str):
        return Refuse("browser_cdp_blocked", {"method": method})
    try:
        inner = parse_client_message(inner_text)
    except MalformedMessage:
        return Refuse("browser_cdp_blocked", {"method": method})
    if str(inner["method"]).startswith("Target."):
        # The relay's own Target checks (download-locked contexts, browser UI targets) see only
        # unwrapped messages.
        return Refuse("browser_cdp_blocked", {"method": f"{method}:{inner['method']}"})
    inner_decision = decide(inner, rules, policy)
    if isinstance(inner_decision, Forward) and inner_decision.message is None:
        return Forward()
    if isinstance(inner_decision, Refuse):
        return inner_decision
    return Refuse("browser_cdp_blocked", {"method": f"{method}:{inner['method']}"})


def clean_url(url: str) -> str:
    """The URL as Chromium parses it: outer C0 controls and spaces trimmed, tabs and newlines removed."""
    return re.sub(r"[\t\n\r]", "", url).strip("".join(chr(c) for c in range(0x21)))


def url_scheme(url: str) -> str | None:
    match = _SCHEME.match(clean_url(url))
    return match.group(1).lower() if match else None


@dataclass(frozen=True)
class NavigationVerdict:
    kind: Literal["allow", "block", "origin"]
    value: str = ""


def classify_navigation(url: str, rules: CdpRules) -> NavigationVerdict:
    """`origin` carries the http(s) origin to check against the policy; `block` carries the scheme.

    An allowlist: http, https and exactly `about:blank`. Every other scheme (other `about:` pages,
    which Edge maps to `edge://`, `blob:`, `filesystem:`, and external protocol handlers such as
    `ms-settings:` or `microsoft-edge:`) reaches browser UI or a host app rather than a web page.
    The contract's blocked list is checked too, so a scheme it adds is refused here regardless.
    """
    cleaned = clean_url(url)
    scheme = url_scheme(cleaned)
    if scheme is None:
        return NavigationVerdict("block", "invalid")
    if scheme in rules.blocked_schemes:
        return NavigationVerdict("block", scheme)
    if scheme == "about" and cleaned[len("about:") :] == "blank":
        return NavigationVerdict("allow")
    if scheme in _DEFAULT_PORTS:
        origin = http_origin(cleaned)
        return NavigationVerdict("origin", origin) if origin else NavigationVerdict("block", "invalid")
    return NavigationVerdict("block", scheme)


def http_origin(url: str) -> str | None:
    """`scheme://host[:port]` the way Chromium canonicalizes an http(s) URL, or None when unparseable."""
    scheme = url_scheme(url)
    if scheme not in _DEFAULT_PORTS:
        return None
    rest = clean_url(url)[len(scheme) + 1 :].replace("\\", "/").lstrip("/")
    authority = re.split(r"[/?#]", rest, maxsplit=1)[0].rpartition("@")[2]
    if authority.startswith("["):
        host, _, port_text = authority.partition("]")
        host += "]"
        port_text = port_text.removeprefix(":")
    else:
        host, _, port_text = authority.partition(":")
    host = unquote(host)
    if host.startswith("["):
        try:
            host = f"[{_whatwg_ipv6(ipaddress.IPv6Address(host[1:-1]))}]"
        except ValueError:
            return None
    else:
        # IDNA first: it turns the ideographic and fullwidth full stops into ASCII dots, which the
        # trailing-dot strip and every check after it must see.
        if not host.isascii():
            if _IDNA_DEVIATIONS & set(host):
                return None
            try:
                host = host.encode("idna").decode("ascii")
            except UnicodeError:
                return None
        host = host.lower().rstrip(".")
        if not _HOST.fullmatch(host) or host.startswith(".") or ".." in host:
            return None
        if _ends_in_number(host):
            canonical = _whatwg_ipv4(host)
            if canonical is None:
                return None
            host = canonical
    if port_text and not port_text.isdigit():
        return None
    port = int(port_text) if port_text else _DEFAULT_PORTS[scheme]
    if not 0 < port < 65536:
        return None
    return f"{scheme}://{host}" if port == _DEFAULT_PORTS[scheme] else f"{scheme}://{host}:{port}"


def origin_host(origin: str) -> str:
    authority = origin.partition("://")[2]
    if authority.startswith("["):
        return authority.partition("]")[0] + "]"
    return authority.partition(":")[0]


def _whatwg_ipv6(address: ipaddress.IPv6Address) -> str:
    """The URL Standard's IPv6 serialization: hex pieces only, the first longest zero run compressed."""
    pieces = [(int(address) >> (16 * (7 - index))) & 0xFFFF for index in range(8)]
    best_start, best_length, start = -1, 1, -1
    for index, piece in enumerate([*pieces, 1]):
        if piece == 0 and start < 0:
            start = index
        elif piece != 0 and start >= 0:
            if index - start > best_length:
                best_start, best_length = start, index - start
            start = -1
    text = [format(piece, "x") for piece in pieces]
    if best_start < 0:
        return ":".join(text)
    return ":".join(text[:best_start]) + "::" + ":".join(text[best_start + best_length :])


def _ends_in_number(host: str) -> bool:
    last = host.split(".")[-1]
    return bool(re.fullmatch(r"[0-9]+|0[xX][0-9A-Fa-f]*", last))


def _whatwg_ipv4(host: str) -> str | None:
    """The URL Standard's IPv4 parser (`http://127.1`, `http://0x7f.1`, `http://2130706433`)."""
    parts = host.split(".")
    if len(parts) > 4:
        return None
    numbers: list[int] = []
    for part in parts:
        if re.fullmatch(r"0[xX][0-9A-Fa-f]*", part):
            numbers.append(int(part[2:] or "0", 16))
        elif re.fullmatch(r"0[0-7]+", part):
            numbers.append(int(part[1:], 8))
        elif re.fullmatch(r"0|[1-9][0-9]*", part):
            numbers.append(int(part))
        else:
            return None
    if any(number > 255 for number in numbers[:-1]) or numbers[-1] >= 256 ** (5 - len(numbers)):
        return None
    value = numbers[-1] + sum(number * 256 ** (3 - index) for index, number in enumerate(numbers[:-1]))
    return str(ipaddress.IPv4Address(value))


def check_upload_paths(files: object, roots: tuple[Path, ...]) -> list[str]:
    """The resolved paths to forward, each a regular file inside a resolved upload root.

    Reads the filesystem: call it off the event loop.
    """
    if (
        not isinstance(files, list)
        or len(files) > _UPLOAD_FILES_MAX
        or not all(isinstance(item, str) and len(item) <= _UPLOAD_PATH_MAX_CHARS for item in files)
    ):
        raise UploadRefused("not_a_path_list")
    resolved_roots: list[Path] = []
    for root in roots:
        try:
            resolved_roots.append(root.resolve(strict=True))
        except OSError:
            continue
    lexical_roots = [*roots, *resolved_roots]
    return [str(_check_upload_path(item, resolved_roots, lexical_roots)) for item in files]


def _check_upload_path(raw: str, resolved_roots: list[Path], lexical_roots: list[Path]) -> Path:
    if raw.startswith(("\\\\", "//")):
        raise UploadRefused("unc_or_device_path")
    path = Path(raw)
    if not path.is_absolute() or len(path.drive) != 2 or path.drive[1] != ":":
        raise UploadRefused("not_drive_absolute")
    if ":" in raw[2:]:
        raise UploadRefused("stream_name")
    if ".." in path.parts:
        raise UploadRefused("parent_reference")
    for component in [path, *path.parents[:-1]]:
        try:
            redirects = _is_name_surrogate(component)
        except OSError as error:
            raise UploadRefused("missing") from error
        if redirects and not any(_within(component, root) for root in lexical_roots):
            raise UploadRefused("reparse_point_outside_roots")
    try:
        resolved = path.resolve(strict=True)
    except OSError as error:
        raise UploadRefused("missing") from error
    if not any(_within(resolved, root) for root in resolved_roots):
        raise UploadRefused("outside_upload_roots")
    if not resolved.is_file():
        raise UploadRefused("not_a_file")
    return resolved


def _is_name_surrogate(path: Path) -> bool:
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode):
        return True
    attributes = getattr(info, "st_file_attributes", 0)
    if not attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
        return False
    return bool(getattr(info, "st_reparse_tag", 0) & _NAME_SURROGATE_BIT)


def _within(path: Path, root: Path) -> bool:
    return path == root or root in path.parents
