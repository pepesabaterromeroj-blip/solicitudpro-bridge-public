import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { readGitState } from "./git-state.js";
import { sanitizeForOutput } from "./security.js";

export interface SolicitudProContext {
  machine: string;
  path: string;
  branch: string;
  head: string;
  dirtyFiles: string[];
  clean: boolean;
  phase: string;
  latestResultDocument: string | null;
  latestResultSummary: string | null;
  documentedTests: string[];
  blockers: string[];
  nextAction: string | null;
  evidence: string[];
}

function firstMatchingLine(content: string, patterns: RegExp[]): string | null {
  for (const line of content.split(/\r?\n/)) {
    const normalized = line.replace(/^#+\s*/, "").trim();
    if (patterns.some((pattern) => pattern.test(normalized))) return normalized.slice(0, 500);
  }
  return null;
}

export async function readSolicitudProContext(repoPath: string): Promise<SolicitudProContext> {
  const git = await readGitState(repoPath);
  const resultDir = path.join(repoPath, "docs", "proyecto");
  let latest: { file: string; mtime: number } | undefined;
  try {
    for (const file of await readdir(resultDir)) {
      if (!/^(RESULTADO|CONTEXTO|CONTINUIDAD).*\.md$/i.test(file)) continue;
      const info = await stat(path.join(resultDir, file));
      if (!latest || info.mtimeMs > latest.mtime) latest = { file, mtime: info.mtimeMs };
    }
  } catch {
    // A missing documentation directory is reported as unavailable, not guessed.
  }

  let content = "";
  if (latest) content = sanitizeForOutput(await readFile(path.join(resultDir, latest.file), "utf8"), 120_000);
  const tests = [...new Set(content.match(/\b\d+\/\d+\s+(?:tests?|pruebas?)\b/gi) ?? [])].slice(0, 10);
  const blockers = content.split(/\r?\n/)
    .map((line) => line.replace(/^[-*#\s]+/, "").trim())
    .filter((line) => /\b(?:bloqueo|bloqueante|pendiente|no verificado)\b/i.test(line))
    .slice(0, 8)
    .map((line) => line.slice(0, 500));
  const phaseFromBranch = git.branch.match(/c\d+[a-z0-9-]*/i)?.[0]?.toUpperCase() ?? "NO VERIFICADO";
  const documentedPhase = firstMatchingLine(content, [/\b(?:C\d+|FASE|ESTADO)\b.*(?:CERRAD|FINALIZAD|PENDIENTE|IMPLEMENTAD)/i]);

  return {
    machine: git.machine,
    path: repoPath,
    branch: git.branch,
    head: git.head,
    dirtyFiles: [...new Set([...git.staged, ...git.unstaged, ...git.untracked])],
    clean: git.clean,
    phase: documentedPhase ?? phaseFromBranch,
    latestResultDocument: latest?.file ?? null,
    latestResultSummary: firstMatchingLine(content, [/^(?:estado|resultado|resumen)/i, /\b(?:CERRAD|FINALIZAD|PENDIENTE|IMPLEMENTAD)\b/i]),
    documentedTests: tests,
    blockers,
    nextAction: firstMatchingLine(content, [/^(?:siguiente|próxim[oa]|next)/i]),
    evidence: ["Git local", latest ? `docs/proyecto/${latest.file}` : "Documentación contemporánea no encontrada"],
  };
}
