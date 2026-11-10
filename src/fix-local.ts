import type { kitConfig } from "./config.js";
import { checkTools } from "./check-tools.js";
import { installTools } from "./install.js";
import {
  readSkillsLock,
  readCliLock,
  readkitMeta,
  updateSkillsLock,
  updateCliLock,
} from "./lock.js";
import { generateSecretsTemplate } from "./fix-template.js";
import { patchGitignore } from "./check-gitignore.js";

interface RepairAction {
  name: string;
  action: string;
  detail: string;
}

async function repairTools(config: kitConfig): Promise<RepairAction[]> {
  if (!config.tools || Object.keys(config.tools).length === 0) return [];
  if ((await checkTools(config.tools)).every((tool) => tool.ok)) return [];
  return (await installTools(config.tools))
    .filter((result) => result.action !== "already_ok")
    .map(({ name, action, detail }) => ({ name, action, detail }));
}

async function repairLocks(config: kitConfig, cwd: string): Promise<RepairAction[]> {
  const actions: RepairAction[] = [];
  if (!(await readSkillsLock(cwd))) {
    const skills = { ...config.skills?.required, ...config.skills?.optional };
    const meta = await readkitMeta(cwd);
    await updateSkillsLock(skills, meta?.name ? `${meta.name}@${meta.version}` : undefined, cwd);
    actions.push({
      name: "skills-lock.json",
      action: "generated",
      detail: "Created skills-lock.json",
    });
  }
  if (!(await readCliLock(cwd))) {
    const tools = Object.fromEntries(
      Object.entries(config.tools ?? {}).map(([name, version]) => [
        name,
        { version, source: "mise" as const },
      ]),
    );
    await updateCliLock(tools, cwd);
    actions.push({ name: "cli-lock.json", action: "generated", detail: "Created cli-lock.json" });
  }
  return actions;
}

async function repairTemplate(config: kitConfig, cwd: string): Promise<RepairAction[]> {
  const name = config.secrets?.template;
  if (!name) return [];
  try {
    const template = await generateSecretsTemplate(config.secrets, cwd);
    return template?.written
      ? [
          {
            name,
            action: "generated",
            detail: `Created ${template.path} with ${template.keyCount} secret placeholders`,
          },
        ]
      : [];
  } catch (error) {
    return [
      { name, action: "failed", detail: error instanceof Error ? error.message : String(error) },
    ];
  }
}

async function repairIgnore(cwd: string): Promise<RepairAction[]> {
  try {
    return (await patchGitignore(cwd)).written
      ? [
          {
            name: ".gitignore",
            action: "fixed",
            detail: "Repaired ignore protection and verified with Git",
          },
        ]
      : [];
  } catch (error) {
    return [
      {
        name: ".gitignore",
        action: "failed",
        detail: error instanceof Error ? error.message : String(error),
      },
    ];
  }
}

/** Structured MCP repairs. The caller must enforce read-only mode and governance first. */
export async function repairLocalProject(config: kitConfig, cwd: string): Promise<RepairAction[]> {
  const actions = await repairTools(config);
  actions.push(...(await repairLocks(config, cwd)));
  actions.push(...(await repairTemplate(config, cwd)));
  actions.push(...(await repairIgnore(cwd)));
  return actions;
}
