import { describe, it, expect, vi } from "vitest";
import { convertClaudeMcpServers, globToAnchoredRegex } from "../src/claudeMcpConfig.js";
import type { ClaudeConversion } from "../src/claudeMcpConfig.js";

// R6 hermeticity: hoisted os.homedir mock so ${HOME} expansion resolves to a
// fake home (never the real one); SDK mocks so no test can reach the real SDK
// or spawn a real server. The converter itself is pure, but the mocks keep the
// file hermetic even if it ever grows SDK imports.
const fakeHome = vi.hoisted(() => `/tmp/pi-mcp-tools-claude-home-${process.pid}`);

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: () => fakeHome };
});

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({ Client: vi.fn() }));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({ StdioClientTransport: vi.fn() }));
vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({ SSEClientTransport: vi.fn() }));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({ StreamableHTTPClientTransport: vi.fn() }));

function convert(raw: unknown): ClaudeConversion {
  return convertClaudeMcpServers(raw);
}

describe("convertClaudeMcpServers", () => {
  describe("local entries (M1: stdio/absent-type -> local)", () => {
    it("converts an entry with absent type to a local server", () => {
      const result = convert({ myserver: { command: "node", args: ["server.js"] } });
      expect(result.skipped).toHaveLength(0);
      expect(result.servers).toHaveLength(1);
      expect(result.servers[0].name).toBe("myserver");
      expect(result.servers[0].config).toEqual({ type: "local", command: ["node", "server.js"] });
    });

    it("converts an explicit stdio type to a local server", () => {
      const result = convert({ myserver: { type: "stdio", command: "node" } });
      expect(result.skipped).toHaveLength(0);
      expect(result.servers[0].config).toEqual({ type: "local", command: ["node"] });
    });

    it("concatenates command and args in order", () => {
      const result = convert({
        s: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] },
      });
      expect(result.servers[0].config).toMatchObject({
        type: "local",
        command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      });
    });

    it("passes env and cwd through", () => {
      const result = convert({ s: { command: "node", env: { KEY: "value" }, cwd: "/work" } });
      expect(result.servers[0].config).toMatchObject({ env: { KEY: "value" }, cwd: "/work" });
    });

    it("skips a local entry without a command", () => {
      const result = convert({ s: { args: ["-x"] } });
      expect(result.servers).toHaveLength(0);
      expect(result.skipped[0]).toMatchObject({ name: "s", reason: "unsupported-shape" });
    });

    it("skips a local entry with a non-array args", () => {
      const result = convert({ s: { command: "node", args: "not-an-array" } });
      expect(result.servers).toHaveLength(0);
      expect(result.skipped[0].reason).toBe("unsupported-shape");
    });
  });

  describe("${HOME} expansion and ${VAR} skips (M1/R2)", () => {
    it("expands the ${HOME} prefix in command using os.homedir()", () => {
      const result = convert({ hermes: { command: "${HOME}/.local/bin/hermes", args: ["mcp", "serve"] } });
      expect(result.skipped).toHaveLength(0);
      expect(result.servers[0].config).toMatchObject({
        type: "local",
        command: [`${fakeHome}/.local/bin/hermes`, "mcp", "serve"],
      });
    });

    it("expands ${HOME} in args and cwd too", () => {
      const result = convert({ s: { command: "node", args: ["--config", "${HOME}/conf.json"], cwd: "${HOME}/work" } });
      expect(result.servers[0].config).toMatchObject({
        command: ["node", "--config", `${fakeHome}/conf.json`],
        cwd: `${fakeHome}/work`,
      });
    });

    it("skips the entry when command carries another unexpanded ${VAR}", () => {
      const result = convert({ s: { command: "${TOOLS}/bin/tool", args: ["serve"] } });
      expect(result.servers).toHaveLength(0);
      expect(result.skipped[0]).toMatchObject({ name: "s", reason: "unexpanded-var" });
      expect(result.skipped[0].detail).toContain("TOOLS");
    });

    it("skips the entry when an arg or cwd carries an unexpanded ${VAR}", () => {
      const withArg = convert({ s: { command: "node", args: ["${MYVAR}"] } });
      expect(withArg.skipped[0].reason).toBe("unexpanded-var");
      const withCwd = convert({ s: { command: "node", cwd: "${OTHER}/x" } });
      expect(withCwd.skipped[0].reason).toBe("unexpanded-var");
    });
  });

  describe("tools filtering (M1: never pass tools:['*'] through)", () => {
    it('maps tools ["*"] to no filtering (no filterPatterns)', () => {
      const result = convert({ s: { command: "node", tools: ["*"] } });
      expect(result.servers[0].config).not.toHaveProperty("filterPatterns");
    });

    it("maps empty or absent tools to no filtering", () => {
      const empty = convert({ s: { command: "node", tools: [] } });
      expect(empty.servers[0].config).not.toHaveProperty("filterPatterns");
      const absent = convert({ s: { command: "node" } });
      expect(absent.servers[0].config).not.toHaveProperty("filterPatterns");
    });

    it('treats a list containing "*" as no filtering (match-all wins)', () => {
      const result = convert({ s: { command: "node", tools: ["*", "srv_x"] } });
      expect(result.servers[0].config).not.toHaveProperty("filterPatterns");
    });

    it("converts a glob pattern to an anchored regex", () => {
      const result = convert({ s: { command: "node", tools: ["srv_*"] } });
      expect(result.servers[0].config).toMatchObject({ filterPatterns: ["^srv_.*$"] });
    });

    it("escapes regex metacharacters when translating a glob (poison input defused)", () => {
      const result = convert({ s: { command: "node", tools: ["a*b("] } });
      expect(result.servers[0].config).toMatchObject({ filterPatterns: ["^a.*b\\($"] });
    });

    it("passes non-glob patterns through unchanged (fork regex semantics)", () => {
      const result = convert({ s: { command: "node", tools: ["^tool_"] } });
      expect(result.servers[0].config).toMatchObject({ filterPatterns: ["^tool_"] });
    });

    it("passes an uncompilable non-glob pattern through for the runtime try/catch to handle", () => {
      const result = convert({ s: { command: "node", tools: ["(("] } });
      expect(result.servers[0].config).toMatchObject({ filterPatterns: ["(("] });
    });

    it("drops malformed tools elements instead of failing the entry", () => {
      const result = convert({ s: { command: "node", tools: [42, "srv_*"] } });
      expect(result.servers[0].config).toMatchObject({ filterPatterns: ["^srv_.*$"] });
    });
  });

  describe("remote entries (M1/D5: http/sse -> remote)", () => {
    it("maps type http with url to a remote server", () => {
      const result = convert({ rider: { type: "http", url: "http://127.0.0.1:64482/stream" } });
      expect(result.skipped).toHaveLength(0);
      expect(result.servers[0].config).toEqual({ type: "remote", url: "http://127.0.0.1:64482/stream" });
    });

    it("maps type sse with url to a remote server", () => {
      const result = convert({ sse_srv: { type: "sse", url: "http://example.com/sse" } });
      expect(result.servers[0].config).toEqual({ type: "remote", url: "http://example.com/sse" });
    });

    it("skips a remote entry without url", () => {
      const result = convert({ rider: { type: "http" } });
      expect(result.servers).toHaveLength(0);
      expect(result.skipped[0]).toMatchObject({ name: "rider", reason: "unsupported-shape" });
    });
  });

  describe("skip semantics (M1: skip entry, still arm the others)", () => {
    it("skips an unknown type with a warning reason", () => {
      const result = convert({ weird: { type: "websocketish", url: "ws://x" } });
      expect(result.servers).toHaveLength(0);
      expect(result.skipped[0]).toMatchObject({ name: "weird", reason: "unsupported-shape" });
    });

    it("skips a non-object entry", () => {
      const result = convert({ bad: "just-a-string", worse: 42, nullish: null });
      expect(result.servers).toHaveLength(0);
      expect(result.skipped).toHaveLength(3);
      expect(result.skipped.every((s) => s.reason === "unsupported-shape")).toBe(true);
    });

    it("still arms the good entries when others are skipped", () => {
      const result = convert({
        good: { command: "node", args: ["a.js"] },
        bad: { type: "unknown" },
        remote: { type: "http", url: "http://127.0.0.1:1/stream" },
      });
      expect(result.servers.map((s) => s.name).sort()).toEqual(["good", "remote"]);
      expect(result.skipped.map((s) => s.name)).toEqual(["bad"]);
    });

    it("returns empty conversion for a non-object mcpServers map", () => {
      expect(convert(null)).toEqual({ servers: [], skipped: [] });
      expect(convert("nope")).toEqual({ servers: [], skipped: [] });
    });
  });
});

describe("globToAnchoredRegex", () => {
  it("translates * to .* and anchors both ends", () => {
    expect(globToAnchoredRegex("srv_*")).toBe("^srv_.*$");
  });

  it("translates ? to a single-character wildcard", () => {
    expect(globToAnchoredRegex("tool-?")).toBe("^tool-.$");
  });

  it("escapes regex metacharacters", () => {
    expect(globToAnchoredRegex("a.b")).toBe("^a\\.b$");
    expect(globToAnchoredRegex("(x)+")).toBe("^\\(x\\)\\+$");
  });

  it("never produces a poison regex from glob input", () => {
    for (const poison of ["*", "**", "a*b(", "${HOME}(*", "?|?"]) {
      expect(() => new RegExp(globToAnchoredRegex(poison))).not.toThrow();
    }
  });
});
