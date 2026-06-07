import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export interface SiteFlowProjectLink {
  projectId: string;
  projectSlug?: string;
  projectName?: string;
  serverUrl?: string;
  linkedAt: string;
}

export function defaultProjectLinkPath(root = process.cwd()) {
  return path.join(root, ".siteflow", "project.json");
}

export async function readProjectLink(root = process.cwd()): Promise<SiteFlowProjectLink | undefined> {
  try {
    const link = JSON.parse(await readFile(defaultProjectLinkPath(root), "utf8")) as Partial<SiteFlowProjectLink>;

    if (!link.projectId) {
      return undefined;
    }

    return {
      projectId: link.projectId,
      projectSlug: link.projectSlug,
      projectName: link.projectName,
      serverUrl: link.serverUrl,
      linkedAt: link.linkedAt ?? new Date().toISOString()
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

export async function writeProjectLink(root: string, link: SiteFlowProjectLink) {
  const linkPath = defaultProjectLinkPath(root);

  await mkdir(path.dirname(linkPath), { recursive: true });
  await writeFile(linkPath, `${JSON.stringify(link, null, 2)}\n`);

  return linkPath;
}
