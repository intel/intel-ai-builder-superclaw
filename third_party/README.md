# Third-party source

Pinned upstream projects that SuperClaw builds from source. Each is a Git
submodule; SuperClaw's changes live as patch files outside it and are applied to
a separate build copy, so keep the submodules unmodified.

| Submodule | Upstream | Version | Patches |
|---|---|---|---|
| `llama.cpp/` | [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp) | build 10830 | `patches/llama.cpp/` |
| `opencode/` | [anomalyco/opencode](https://github.com/anomalyco/opencode) | 1.18.25 | `patches/opencode/` |

`patches/upstream.lock.json` records the pinned commits and is the authority for
them. The patch scripts check the submodule URL in `.gitmodules`, the commit the
superproject records, and the patch hashes against it.

## Check out and verify

From the repository root:

```powershell
git submodule update --init third_party/llama.cpp third_party/opencode
git submodule status -- third_party
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\patches\verify-lock.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\patches\opencode-verify-lock.ps1
```

Do not use `git submodule update --remote`; the build rejects any commit other
than the pinned one.

## Build

- **llama.cpp:** apply the patch and build the Windows SYCL bundle as described in
  [`scripts/patches/README.md`](../scripts/patches/README.md).
- **OpenCode:** `packaging/installer/build-superclaw.ps1` applies the patch and
  builds the runtime when needed; see the OpenCode section of the same guide.
