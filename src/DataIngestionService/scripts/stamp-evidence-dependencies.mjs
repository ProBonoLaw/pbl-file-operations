import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

// Include parser/transitive dependency changes in queued checkpoint identities.
// The runtime image contains dist and node_modules, not the build's lockfile.
const lock = await readFile(new URL("../bun.lock", import.meta.url));
const target = new URL("../dist/src/processors/evidence/", import.meta.url);
await mkdir(target, {recursive:true});
await writeFile(new URL("evidenceDependencies.sha256", target), createHash("sha256").update(lock).digest("hex"));
