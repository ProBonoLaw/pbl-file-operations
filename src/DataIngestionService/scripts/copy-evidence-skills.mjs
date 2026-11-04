import { cp, mkdir } from "node:fs/promises";
const source = new URL("../src/processors/evidence/skills/", import.meta.url);
const target = new URL("../dist/src/processors/evidence/skills/", import.meta.url);
await mkdir(target, {recursive:true});
await cp(source, target, {recursive:true});
