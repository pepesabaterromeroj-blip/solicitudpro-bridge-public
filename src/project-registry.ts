import { access, readFile, realpath } from "node:fs/promises";

export interface ProjectConfig {
  path: string;
  description?: string;
  contextSources?: Array<{ path: string; role: 'instructions' | 'operational' | 'continuity' | 'phase-result' }>;
  searchRoots?: string[];
  changeRoots?: string[];
}

export interface LocalConfig {
  projects: Record<string, ProjectConfig>;
  relay?: { enabled?: boolean; deviceId?: string; gatewayOrigin?: string; tokenFile?: string };
  codex?: {
    command?: string;
    defaultModel?: string | null;
    defaultReasoningEffort?: string;
    defaultSandbox?: "read-only" | "workspace-write";
    defaultApprovalPolicy?: "untrusted" | "on-request";
  };
  tunnel?: { enabled?: boolean; status?: string };
}

export interface ResolvedProject extends ProjectConfig {
  id: string;
  path: string;
}

export class ProjectRegistry {
  private constructor(
    readonly config: LocalConfig,
    private readonly projects: Map<string, ResolvedProject>,
  ) {}

  static async load(configPath: string): Promise<ProjectRegistry> {
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as LocalConfig;
    if (!parsed.projects || typeof parsed.projects !== "object") throw new Error("Local config must define projects");
    const projects = new Map<string, ResolvedProject>();
    for (const [id, project] of Object.entries(parsed.projects)) {
      if (!/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(id)) throw new Error(`Invalid project id: ${id}`);
      if (!project || typeof project.path !== "string" || !project.path.trim()) throw new Error(`Project ${id} has no path`);
      try {
        await access(project.path);
      } catch {
        throw new Error(`Configured path for project ${id} does not exist`);
      }
      const canonicalPath = await realpath(project.path);
      projects.set(id, { ...project, id, path: canonicalPath });
    }
    return new ProjectRegistry(parsed, projects);
  }

  resolve(id: string): ResolvedProject {
    const project = this.projects.get(id);
    if (!project) throw new Error(`Project is not authorized: ${id}`);
    return project;
  }

  list(): Array<Pick<ResolvedProject, "id" | "description">> {
    return [...this.projects.values()].map(({ id, description }) => ({ id, description }));
  }
}
