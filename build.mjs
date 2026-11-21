// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const revision = git("rev-parse", "--verify", "HEAD");
const clean = git("status", "--porcelain") === "";
if (process.env.FINDMESTILL_REVISION && (!clean || process.env.FINDMESTILL_REVISION !== revision)) {
  throw new Error("The source tree must be clean and match the requested revision");
}
await rm("dist", { force: true, recursive: true });
await mkdir("dist");
await cp("public", "dist", { recursive: true });
await cp("LICENSE", "dist/LICENSE");
if (clean) execFileSync("git", ["archive", "--format=tar.gz", "--prefix=findmestill/", "-o", "dist/source.tar.gz", "HEAD"]);
await writeFile("dist/release.json", JSON.stringify({ revision: clean ? revision : null, discovery: "0.1" }) + "\n");
