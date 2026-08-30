import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConfigLoader } from "../src/ConfigLoader.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";

// ConfigLoader derives the global settings path from homedir() at import
// time, so os.homedir is mocked before the module loads.
const fakeHome = vi.hoisted(() => `/tmp/pi-mcp-tools-test-home-${process.pid}`);

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: () => fakeHome };
});

// We test ConfigLoader's validation/enumeration logic directly.
// File I/O tests use mock fs to avoid polluting the real ~/.pi/.

describe("ConfigLoader", () => {
  describe("validateConfig", () => {
    it("rejects null/empty config", () => {
      const result = ConfigLoader.validateConfig(null as unknown as any);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("rejects config with missing server type", () => {
      const result = ConfigLoader.validateConfig({
        myserver: {} as any,
      });
      expect(result.valid).toBe(false);
    });

    it("rejects config with invalid server type", () => {
      const result = ConfigLoader.validateConfig({
        myserver: { type: "invalid" },
      });
      expect(result.valid).toBe(false);
    });

    it("rejects local server missing command", () => {
      const result = ConfigLoader.validateConfig({
        myserver: { type: "local" },
      });
      expect(result.valid).toBe(false);
    });

    it("rejects local server with non-array command", () => {
      const result = ConfigLoader.validateConfig({
        myserver: { type: "local", command: "node" },
      });
      expect(result.valid).toBe(false);
    });

    it("accepts valid local server config", () => {
      const result = ConfigLoader.validateConfig({
        filesystem: { type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
      });
      expect(result.valid).toBe(true);
    });

    it("accepts local server with all optional fields", () => {
      const result = ConfigLoader.validateConfig({
        "my-server": {
          type: "local",
          command: ["node", "server.js"],
          env: { KEY: "value" },
          cwd: "/tmp",
          enabled: true,
          toolPrefix: "custom",
          filterPatterns: ["^tool_"],
        },
      });
      expect(result.valid).toBe(true);
    });

    it("rejects remote server missing url", () => {
      const result = ConfigLoader.validateConfig({
        myserver: { type: "remote" },
      });
      expect(result.valid).toBe(false);
    });

    it("accepts valid remote server config", () => {
      const result = ConfigLoader.validateConfig({
        web: { type: "remote", url: "https://example.com/mcp" },
      });
      expect(result.valid).toBe(true);
    });

    it("validates multiple servers independently", () => {
      const result = ConfigLoader.validateConfig({
        good: { type: "local", command: ["node", "srv.js"] },
        bad: { type: "local" },
      });
      expect(result.valid).toBe(false);
    });
  });

  describe("getEnabledServers", () => {
    it("returns all servers when no enabled field", () => {
      const result = ConfigLoader.getEnabledServers({
        s1: { type: "local", command: ["node", "a.js"] },
        s2: { type: "local", command: ["node", "b.js"] },
      });
      expect(result).toHaveLength(2);
    });

    it("excludes disabled servers", () => {
      const result = ConfigLoader.getEnabledServers({
        s1: { type: "local", command: ["node", "a.js"], enabled: false },
        s2: { type: "local", command: ["node", "b.js"], enabled: true },
      });
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("s2");
    });

    it("returns empty array when all disabled", () => {
      const result = ConfigLoader.getEnabledServers({
        s1: { type: "local", command: ["node", "a.js"], enabled: false },
      });
      expect(result).toHaveLength(0);
    });
  });

  describe("loadProjectMcpJson", () => {
    const projectDir = join(fakeHome, "proj");

    function writeProjectFile(content: string): string {
      mkdirSync(projectDir, { recursive: true });
      const path = join(projectDir, ".mcp.json");
      writeFileSync(path, content, "utf-8");
      return path;
    }

    it("returns an empty non-error result when no .mcp.json exists", () => {
      const result = ConfigLoader.loadProjectMcpJson(join(fakeHome, "no-such-project"));
      expect(result).toEqual({ servers: [], skipped: [], parseError: null, exists: false });
    });

    it("reads and converts a project .mcp.json (claude -> fork format)", () => {
      writeProjectFile(
        JSON.stringify({
          mcpServers: {
            hermes: { command: "${HOME}/.local/bin/hermes", args: ["mcp", "serve"], tools: ["*"] },
          },
        }),
      );
      const result = ConfigLoader.loadProjectMcpJson(projectDir);
      expect(result.exists).toBe(true);
      expect(result.parseError).toBeNull();
      expect(result.skipped).toHaveLength(0);
      expect(result.servers[0].name).toBe("hermes");
      expect(result.servers[0].config).toEqual({
        type: "local",
        command: [`${fakeHome}/.local/bin/hermes`, "mcp", "serve"],
      });
    });

    it("reports a parseError and arms nothing for an unparseable file (no partial merge)", () => {
      writeProjectFile("{ this is not json");
      const result = ConfigLoader.loadProjectMcpJson(projectDir);
      expect(result.exists).toBe(true);
      expect(result.parseError).toBeTruthy();
      expect(result.servers).toHaveLength(0);
    });

    it("keeps parseError null but records skips for malformed entries", () => {
      writeProjectFile(JSON.stringify({ mcpServers: { good: { command: "node" }, bad: { type: "unknown" } } }));
      const result = ConfigLoader.loadProjectMcpJson(projectDir);
      expect(result.parseError).toBeNull();
      expect(result.servers.map((s) => s.name)).toEqual(["good"]);
      expect(result.skipped[0]).toMatchObject({ name: "bad", reason: "unsupported-shape" });
    });

    it("treats a file without mcpServers as inert", () => {
      writeProjectFile(JSON.stringify({ something: "else" }));
      const result = ConfigLoader.loadProjectMcpJson(projectDir);
      expect(result.exists).toBe(true);
      expect(result.servers).toHaveLength(0);
      expect(result.skipped).toHaveLength(0);
      expect(result.parseError).toBeNull();
    });
  });

  describe("mergeMcpConfigs", () => {
    const globalCfg = {
      alpha: { type: "local" as const, command: ["global-alpha"] },
      beta: { type: "local" as const, command: ["global-beta"] },
    };

    it("gives project entries precedence over global entries with the same name", () => {
      const project = {
        servers: [{ name: "alpha", config: { type: "local" as const, command: ["project-alpha"] } }],
        skipped: [],
        parseError: null as string | null,
        exists: true,
      };
      const { config, ledger } = ConfigLoader.mergeMcpConfigs(globalCfg, project, true);
      expect(config!.alpha).toEqual({ type: "local", command: ["project-alpha"] });
      expect(config!.beta).toEqual({ type: "local", command: ["global-beta"] });
      expect(ledger.entries.find((e) => e.name === "alpha")!.source).toBe("project:.mcp.json");
      expect(ledger.entries.find((e) => e.name === "beta")!.source).toBe("global settings");
    });

    it("keeps global-only names armed when the project declares other names", () => {
      const project = {
        servers: [{ name: "gamma", config: { type: "local" as const, command: ["project-gamma"] } }],
        skipped: [],
        parseError: null as string | null,
        exists: true,
      };
      const { config, ledger } = ConfigLoader.mergeMcpConfigs(globalCfg, project, true);
      expect(config!.alpha).toEqual({ type: "local", command: ["global-alpha"] });
      expect(config!.gamma).toEqual({ type: "local", command: ["project-gamma"] });
      expect(ledger.entries.find((e) => e.name === "alpha")!.source).toBe("global settings");
    });

    it("a skipped project entry shadows the same-named global entry", () => {
      const project = {
        servers: [],
        skipped: [{ name: "alpha", reason: "unexpanded-var" as const, detail: "unexpanded ${TOOLS} in command" }],
        parseError: null as string | null,
        exists: true,
      };
      const { config, ledger } = ConfigLoader.mergeMcpConfigs(globalCfg, project, true);
      expect(config!.alpha).toBeUndefined();
      expect(config!.beta).toEqual({ type: "local", command: ["global-beta"] });
      expect(ledger.entries.find((e) => e.name === "alpha")!.source).toBe("skipped:unexpanded-var");
    });

    it("falls back to global-only for an untrusted project and records untrusted-project rows", () => {
      const project = {
        servers: [{ name: "alpha", config: { type: "local" as const, command: ["project-alpha"] } }],
        skipped: [],
        parseError: null as string | null,
        exists: true,
      };
      const { config, ledger } = ConfigLoader.mergeMcpConfigs(globalCfg, project, false);
      expect(config!.alpha).toEqual({ type: "local", command: ["global-alpha"] });
      expect(config!.gamma).toBeUndefined();
      expect(ledger.entries.find((e) => e.name === "alpha")!.source).toBe("untrusted-project");
      expect(ledger.entries.find((e) => e.name === "beta")!.source).toBe("global settings");
      expect(ledger.untrustedCount).toBe(1);
    });

    it("treats a missing project file as no project at all (all-global ledger)", () => {
      const { config, ledger } = ConfigLoader.mergeMcpConfigs(globalCfg, null, true);
      expect(config).toEqual(globalCfg);
      expect(ledger.entries.map((e) => e.source)).toEqual(["global settings", "global settings"]);
      expect(ledger.untrustedCount).toBe(0);
    });

    it("treats a not-existing project result as no project", () => {
      const project = { servers: [], skipped: [], parseError: null as string | null, exists: false };
      const { config, ledger } = ConfigLoader.mergeMcpConfigs(globalCfg, project, false);
      expect(config).toEqual(globalCfg);
      expect(ledger.untrustedCount).toBe(0);
    });

    it("an unparseable project file yields global-only plus a warning, never a partial arm", () => {
      const project = {
        servers: [{ name: "alpha", config: { type: "local" as const, command: ["should-not-arm"] } }],
        skipped: [],
        parseError: "Unexpected token" as string,
        exists: true,
      };
      const { config, ledger } = ConfigLoader.mergeMcpConfigs(globalCfg, project, true);
      expect(config).toEqual(globalCfg);
      expect(ledger.warnings.some((w) => w.includes("unparseable"))).toBe(true);
      expect(JSON.stringify(config)).not.toContain("should-not-arm");
    });

    it("counts only skipped:* sources in skippedCount", () => {
      const project = {
        servers: [{ name: "gamma", config: { type: "local" as const, command: ["project-gamma"] } }],
        skipped: [
          { name: "alpha", reason: "unexpanded-var" as const, detail: "x" },
          { name: "delta", reason: "unsupported-shape" as const, detail: "y" },
        ],
        parseError: null as string | null,
        exists: true,
      };
      const { ledger } = ConfigLoader.mergeMcpConfigs(globalCfg, project, true);
      expect(ledger.skippedCount).toBe(2);
      expect(ledger.untrustedCount).toBe(0);
    });
  });

  describe("saveDisabledTools atomicity", () => {
    const agentDir = join(fakeHome, ".pi", "agent");
    const settingsPath = join(agentDir, "settings.json");

    it("writes through a temp file and leaves no temp files behind (user keys preserved)", () => {
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({ theme: "dark", mcp: {} }), "utf-8");

      ConfigLoader.saveDisabledTools(new Set(["mcp_srv_tool"]));

      const saved = JSON.parse(readFileSync(settingsPath, "utf-8"));
      expect(saved.theme).toBe("dark");
      expect(saved.mcpDisabledTools).toEqual(["mcp_srv_tool"]);
      const leftovers = readdirSync(agentDir).filter((f) => f !== "settings.json");
      expect(leftovers).toEqual([]);
    });

    it("a failed write leaves settings.json untouched, cleans up, and does not throw", () => {
      if (typeof process.getuid === "function" && process.getuid() === 0) {
        return; // chmod-based failure injection does not bite for root
      }
      mkdirSync(agentDir, { recursive: true });
      const original = JSON.stringify({ theme: "dark" }, null, 2) + "\n";
      writeFileSync(settingsPath, original, "utf-8");
      chmodSync(agentDir, 0o555);
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

      try {
        expect(() => ConfigLoader.saveDisabledTools(new Set(["mcp_srv_tool"]))).not.toThrow();
        expect(readFileSync(settingsPath, "utf-8")).toBe(original);
        expect(consoleError).toHaveBeenCalled();
        const leftovers = readdirSync(agentDir).filter((f) => f !== "settings.json");
        expect(leftovers).toEqual([]);
      } finally {
        chmodSync(agentDir, 0o755);
        consoleError.mockRestore();
      }
    });
  });

  describe("saveDisabledTools", () => {
    it("warns when settings.json is missing instead of failing silently", () => {
      rmSync(join(fakeHome, ".pi"), { recursive: true, force: true });
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

      expect(() => ConfigLoader.saveDisabledTools(new Set(["mcp_x_y"]))).not.toThrow();
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("Cannot save disabled tools"));
      expect(consoleError.mock.calls[0][0]).toContain(".pi");

      consoleError.mockRestore();
    });
  });
});
