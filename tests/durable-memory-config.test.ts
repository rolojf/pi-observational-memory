import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadMemoryConfig } from "../src/durable-memory/config.js";

let root: string;
let project: string;
let agentDir: string;

function settings(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify({ "durable-memory": value }));
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "om-durable-config-"));
	project = join(root, "project");
	agentDir = join(root, "agent");
	mkdirSync(project);
	mkdirSync(agentDir);
	vi.stubEnv("GIT_CEILING_DIRECTORIES", root);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

describe("durable memory configuration", () => {
	it("is disabled without opt-in and does not require a Git root", () => {
		expect(loadMemoryConfig(project, agentDir)).toEqual({ mode: "off" });
	});

	it("lets project settings override global enablement", () => {
		settings(join(agentDir, "settings.json"), { enabled: true });
		settings(join(project, ".pi", "settings.json"), { enabled: false });
		expect(loadMemoryConfig(project, agentDir)).toEqual({ mode: "off" });
	});

	it("uses the nearest Git worktree root from a nested session directory", () => {
		execFileSync("git", ["init", "--quiet", project]);
		const nested = join(project, "src", "deep");
		mkdirSync(nested, { recursive: true });
		settings(join(agentDir, "settings.json"), { enabled: true });
		expect(loadMemoryConfig(nested, agentDir)).toEqual({ mode: "project", projectRoot: project });
	});

	it("accepts a worktree .git file and does not escape into its parent repo", () => {
		execFileSync("git", ["init", "--quiet", root]);
		execFileSync("git", ["init", "--quiet", "--separate-git-dir", join(root, "git-data"), project]);
		settings(join(project, ".pi", "settings.json"), { enabled: true });
		expect(loadMemoryConfig(project, agentDir)).toEqual({ mode: "project", projectRoot: project });
	});

	it("does not mistake a stray .git directory for a worktree", () => {
		mkdirSync(join(project, ".git"));
		settings(join(project, ".pi", "settings.json"), { enabled: true });
		expect(loadMemoryConfig(project, agentDir)).toMatchObject({ mode: "off", problem: expect.stringContaining("explicit projectRoot") });
	});

	it("requires an explicit project root outside Git", () => {
		settings(join(project, ".pi", "settings.json"), { enabled: true });
		expect(loadMemoryConfig(project, agentDir)).toMatchObject({ mode: "off", problem: expect.stringContaining("explicit projectRoot") });
		settings(join(project, ".pi", "settings.json"), { enabled: true, projectRoot: "." });
		expect(loadMemoryConfig(project, agentDir)).toEqual({ mode: "project", projectRoot: project });
	});

	it("rejects an unrelated configured root", () => {
		settings(join(project, ".pi", "settings.json"), { enabled: true, projectRoot: agentDir });
		expect(loadMemoryConfig(project, agentDir)).toMatchObject({ mode: "off", problem: expect.stringContaining("containing") });
	});

	it("rejects a configured ancestor outside the current Git worktree", () => {
		execFileSync("git", ["init", "--quiet", project]);
		settings(join(project, ".pi", "settings.json"), { enabled: true, projectRoot: ".." });
		expect(loadMemoryConfig(project, agentDir)).toMatchObject({ mode: "off", problem: expect.stringContaining("inside") });
	});

	it("canonicalizes symlinked project roots", () => {
		const alias = join(root, "alias");
		symlinkSync(project, alias);
		settings(join(project, ".pi", "settings.json"), { enabled: true, projectRoot: alias });
		expect(loadMemoryConfig(project, agentDir)).toEqual({ mode: "project", projectRoot: project });
	});

	it("disables invalid project settings rather than inheriting global opt-in", () => {
		settings(join(agentDir, "settings.json"), { enabled: true });
		settings(join(project, ".pi", "settings.json"), { enabled: "true" });
		expect(loadMemoryConfig(project, agentDir)).toMatchObject({ mode: "off", problem: expect.stringContaining("boolean") });
		writeFileSync(join(project, ".pi", "settings.json"), "{broken");
		expect(loadMemoryConfig(project, agentDir)).toMatchObject({ mode: "off", problem: expect.any(String) });
	});

	it("adds a shared read root only when explicitly configured", () => {
		settings(join(project, ".pi", "settings.json"), { enabled: true, projectRoot: ".", sharedMemoryRoot: "../shared" });
		expect(loadMemoryConfig(project, agentDir)).toEqual({
			mode: "project",
			projectRoot: project,
			sharedRoot: join(root, "shared"),
		});
	});
});
