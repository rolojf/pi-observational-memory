import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const SETTINGS_KEY = "durable-memory";
const ROOT_TIMEOUT_MS = 1_000;

export type MemoryConfig =
	| { mode: "off"; problem?: string }
	| { mode: "project"; projectRoot: string; sharedRoot?: string };

type Settings = {
	enabled?: boolean;
	projectRoot?: string;
	sharedMemoryRoot?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSettings(path: string): Settings {
	if (!existsSync(path)) return {};

	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isRecord(parsed)) throw new Error(`Invalid settings object: ${path}`);
	const value = parsed[SETTINGS_KEY];
	if (value === undefined) return {};
	if (!isRecord(value)) throw new Error(`Invalid ${SETTINGS_KEY} settings: ${path}`);

	const settings: Settings = {};
	if (value.enabled !== undefined) {
		if (typeof value.enabled !== "boolean") throw new Error("durable-memory.enabled must be a boolean");
		settings.enabled = value.enabled;
	}
	for (const key of ["projectRoot", "sharedMemoryRoot"] as const) {
		if (value[key] === undefined) continue;
		if (typeof value[key] !== "string" || !value[key].trim()) {
			throw new Error(`durable-memory.${key} must be a non-empty path`);
		}
		settings[key] = value[key];
	}
	return settings;
}

function expandPath(path: string, cwd: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(homedir(), path.slice(2));
	return resolve(cwd, path);
}

function containsPath(root: string, path: string): boolean {
	const child = relative(root, path);
	return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function findGitRoot(cwd: string): string | undefined {
	try {
		// Ask Git rather than mistake a stray .git directory for a worktree.
		const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: ROOT_TIMEOUT_MS,
		}).replace(/\r?\n$/, "");
		return realpathSync(root);
	} catch {
		return undefined;
	}
}

/** Resolve an explicit project scope without changing the upstream settings loader. */
export function loadMemoryConfig(cwd: string, agentDir = getAgentDir()): MemoryConfig {
	try {
		// Follow Pi's settings locations: project settings belong to the session cwd.
		const settings = {
			...readSettings(join(agentDir, "settings.json")),
			...readSettings(join(cwd, ".pi", "settings.json")),
		};
		if (settings.enabled !== true) return { mode: "off" };

		const current = realpathSync(cwd);
		const gitRoot = findGitRoot(current);
		const projectRoot = settings.projectRoot
			? realpathSync(expandPath(settings.projectRoot, current))
			: gitRoot;
		if (!projectRoot) {
			return { mode: "off", problem: "Durable memory requires a Git worktree or an explicit projectRoot." };
		}
		if (!statSync(projectRoot).isDirectory() || !containsPath(projectRoot, current)) {
			return { mode: "off", problem: "Durable memory projectRoot must be a directory containing the session cwd." };
		}
		if (gitRoot && !containsPath(gitRoot, projectRoot)) {
			return { mode: "off", problem: "Durable memory projectRoot must stay inside the current Git worktree." };
		}

		const sharedRoot = settings.sharedMemoryRoot
			? expandPath(settings.sharedMemoryRoot, current)
			: undefined;
		return { mode: "project", projectRoot, ...(sharedRoot ? { sharedRoot } : {}) };
	} catch (error) {
		return { mode: "off", problem: `Durable memory configuration: ${error instanceof Error ? error.message : String(error)}` };
	}
}
