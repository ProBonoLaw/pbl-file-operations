import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { AgentMiddleware } from "langchain";
import { MiddlewareError } from "langchain";

export type EvidenceSpecialistMode = "off" | "skills";
export type EvidenceSkillName = "claim-attribution" | "evidence-identity";
export const EVIDENCE_SKILL_NAMES: readonly EvidenceSkillName[] = ["claim-attribution", "evidence-identity"];
const versions: Record<EvidenceSkillName, string> = {"claim-attribution":"1", "evidence-identity":"19"};
const root = new URL("./skills/", import.meta.url);

/** Preserve the application's structured-output recovery and loop handling. */
export function unwrapEvidenceMiddlewareError(value: unknown): unknown {
  const seen = new Set<unknown>();
  while (MiddlewareError.isInstance(value) && value.cause instanceof Error && !seen.has(value)) {
    seen.add(value);
    value = value.cause;
  }
  return value;
}

export function evidenceSpecialistMode(value = process.env.EVIDENCE_SPECIALIST_MODE): EvidenceSpecialistMode {
  const mode = value?.trim() || "off";
  if (mode !== "off" && mode !== "skills") throw new Error("EVIDENCE_SPECIALIST_MODE must be off or skills");
  return mode;
}

export function skillForStage(stage: string): EvidenceSkillName | null {
  if (stage === "claim-attribution") return "claim-attribution";
  if (stage === "canonicalization") return "evidence-identity";
  return null;
}

export async function loadEvidenceSkill(name: EvidenceSkillName) {
  if (!EVIDENCE_SKILL_NAMES.includes(name)) throw new Error("Unknown evidence skill");
  const [instructions, examples] = await Promise.all([
    readFile(new URL(`${name}/SKILL.md`, root), "utf8"),
    readFile(new URL(`${name}/references/examples.md`, root), "utf8"),
  ]);
  if (!instructions.startsWith(`---\nname: ${name}\n`) || !instructions.includes(`  version: "${versions[name]}"`)) {
    throw new Error(`Invalid evidence skill metadata: ${name}`);
  }
  return { name, version: versions[name], instructions,
    hash: createHash("sha256").update(JSON.stringify([instructions, examples])).digest("hex") };
}

export async function evidenceSkillsFingerprint(): Promise<string> {
  const skills = await Promise.all(EVIDENCE_SKILL_NAMES.map(loadEvidenceSkill));
  return createHash("sha256").update(JSON.stringify(skills.map(skill => [skill.name, skill.hash]))).digest("hex");
}

/** Deep Agents' skill middleware inside the existing bounded LangChain invocation. */
export async function evidenceSkillRuntime(name: EvidenceSkillName): Promise<{
  systemPrompt: string; middleware: AgentMiddleware[]; name: EvidenceSkillName; version: string; hash: string;
}> {
  const skill = await loadEvidenceSkill(name);
  const { FilesystemBackend, createFilesystemMiddleware, createSkillsMiddleware } = await import("deepagents");
  const backend = new FilesystemBackend({rootDir: fileURLToPath(root), virtualMode: true});
  return {
    ...skill,
    // Mandatory procedures are supplied directly. Reading examples is optional;
    // successful output never depends on the model discovering the SKILL.md.
    systemPrompt: `Required procedure already loaded: ${name} (version ${skill.version}). Follow it for this review. Its examples at /${name}/references/examples.md are optional; rereading SKILL.md is unnecessary.\n${skill.instructions}`,
    middleware: [
      createFilesystemMiddleware({backend, tools:["read_file"],
        toolTokenLimitBeforeEvict: null, humanMessageTokenLimitBeforeEvict: null,
        permissions:[{operations:["read"],paths:[`/${name}/**`]}, {operations:["read"],paths:["/**"],mode:"deny"}]}),
      createSkillsMiddleware({backend, sources:[`/${name}/`]}),
    ],
  };
}
