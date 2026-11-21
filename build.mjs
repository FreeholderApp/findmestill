// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

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

const shellFiles = [
  "/index.html", "/style.css", "/app.mjs", "/discovery.mjs",
  "/manifest.webmanifest", "/icons/findmestill-192.png", "/icons/findmestill-512.png",
  "/fixtures/discovery-v0.1.json",
];
const integrity = path => readFile("dist" + path).then(bytes => "sha256-" + createHash("sha256").update(bytes).digest("base64"));
const shell = Object.fromEntries(await Promise.all(shellFiles.map(async path => [path, await integrity(path)])));
shell["/"] = shell["/index.html"];
const worker = await readFile("service-worker.js", "utf8");
const shellVersion = createHash("sha256").update(JSON.stringify(shell)).update(worker).digest("hex");
await writeFile("dist/sw.js", `const shellVersion = ${JSON.stringify(shellVersion)};\nconst shellAssets = ${JSON.stringify(shell)};\n${worker}`);
