#!/usr/bin/env node
import { resolve } from "node:path";

import { compareProductProfileRoots } from "./product-profile-digest.mjs";

const [, , sourceRoot, packagedRoot] = process.argv;
if (!sourceRoot || !packagedRoot) {
  throw new Error("usage: check-product-profile-parity.mjs <source-profiles-root> <packaged-profiles-root>");
}

const digests = compareProductProfileRoots(resolve(sourceRoot), resolve(packagedRoot));
for (const [profile, digest] of Object.entries(digests)) {
  console.log(`${profile} sha256:${digest}`);
}
console.log("Product Profile packaging parity verified");
