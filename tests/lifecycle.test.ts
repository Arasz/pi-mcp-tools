import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import piMcpToolsFactory from "../src/index.js";
import { ConfigLoader } from "../src/ConfigLoader.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

// R6 hermeticity: hoisted os.homedir mock (ConfigLoader derives the global
// settings path from it at import time) + SDK client mocks. Nothing in this
// file may touch the real ~/.pi or spawn a real server.
const fakeHome = vi.hoisted(() => `/tmp/pi-mcp-tools-lifecycle-home-${process.pid}`);

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: () => fakeHome };
});

const sdk = vi.hoisted(() => ({
  clients: [] as any[],
  tools: [] as any[],
  failConnect: false,
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => {
    const instance = {
      connect: vi.fn(async () => {
        if (sdk.failConnect) throw new Error("spawn failed");
      }),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn(async () => ({ tools: sdk.tools })),
      callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
      setNotificationHandler: vi.fn(),
      onclose: null,
      onerror: null,
    };
    sdk.clients.push(instance);
    return instance;
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn(),
}));

const agentDir = join(fakeHome, ".pi", "agent");
const settingsPath = join(agentDir, "settings.json");

function writeGlobalSettings(settings: Record<string, unknown>): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings), "utf-8");
}

function writeProjectMcpJson(cwd: string, mcpServers: Record<string, unknown> | null): void {
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers }), "utf-8");
}

function createMockPi() {
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => Promise<void> | void>();
  const tools: any[] = [];
  const commands = new Map<
    string,
    { description: string; handler: (args: any, ctx: ExtensionContext) => Promise<void> | void }
  >();
  const flags: Array<{ name: string; options: unknown }> = [];
  const pi = {
    on: vi.fn((event: string, handler: (event: any, ctx: ExtensionContext) => Promise<void> | void) => {
      handlers.set(event, handler);
    }),
    registerTool: vi.fn((tool: any) => {
      tools.push(tool);
    }),
    registerCommand: vi.fn(
      (
        name: string,
        options: { description: string; handler: (args: any, ctx: ExtensionContext) => Promise<void> | void },
      ) => {
        commands.set(name, options);
      },
    ),
    registerFlag: vi.fn((name: string, options: unknown) => {
      flags.push({ name, options });
    }),
    getFlag: vi.fn(() => false),
    getAllTools: vi.fn(() => [] as Array<{ name: string }>),
    setActiveTools: vi.fn(),
  };
  return { pi: pi as unknown as ExtensionAPI, raw: pi, handlers, tools, commands, flags };
}

function createMockCtx(cwd: string, trusted = true): ExtensionContext {
  return {
    cwd,
    mode: "print",
    hasUI: false,
    isProjectTrusted: vi.fn(() => trusted),
    ui: {
      notify: vi.fn(),
      setStatus: vi.fn(),
    },
  } as unknown as ExtensionContext;
}

const startEvent = { type: "session_start", reason: "startup" };
const shutdownEvent = { type: "session_shutdown", reason: "quit" };

async function startSession(
  harness: ReturnType<typeof createMockPi>,
  cwd: string,
  trusted = true,
): Promise<ExtensionContext> {
  const ctx = createMockCtx(cwd, trusted);
  await harness.handlers.get("session_start")!(startEvent, ctx);
  return ctx;
}

function listServersTool(harness: ReturnType<typeof createMockPi>): any {
  const tool = harness.tools.find((t) => t.name === "mcp_list_servers");
  if (!tool) throw new Error("mcp_list_servers tool not registered");
  return tool;
}

async function listServersReport(harness: ReturnType<typeof createMockPi>): Promise<any> {
  const result = await listServersTool(harness).execute("call-1", {}, undefined, undefined);
  return result.details;
}

describe("pi-mcp-tools lifecycle", () => {
  let harness: ReturnType<typeof createMockPi>;

  beforeEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    sdk.clients.length = 0;
    sdk.tools = [];
    sdk.failConnect = false;
    harness = createMockPi();
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("arms project .mcp.json servers from ctx.cwd at session_start", async () => {
    const cwd = join(fakeHome, "proj-a");
    writeProjectMcpJson(cwd, { hermes: { command: "node", args: ["hermes.js"], tools: ["*"] } });
    sdk.tools = [{ name: "ping", description: "ping", inputSchema: { type: "object" } }];

    await piMcpToolsFactory(harness.pi);
    const ctx = await startSession(harness, cwd, true);

    const report = await listServersReport(harness);
    expect(report.initialized).toBe(true);
    expect(report.servers).toHaveLength(1);
    expect(report.servers[0]).toMatchObject({ name: "hermes", source: "project:.mcp.json", connected: true });
    expect(report.skippedCount).toBe(0);

    // The registered pi tool uses the default mcp_<server> prefix.
    expect(harness.tools.some((t) => t.name === "mcp_hermes_ping")).toBe(true);
    // Exactly one SDK client was constructed — no real server spawn.
    expect(sdk.clients.length).toBe(1);
    // session_start status names the merged source.
    const notifyCalls = (ctx.ui.notify as any).mock.calls.map((c: any[]) => String(c[0]));
    expect(notifyCalls.some((m: string) => m.includes("project:.mcp.json"))).toBe(true);
    expect(
      (ctx.ui.setStatus as any).mock.calls.some((c: any[]) => String(c[0]) === "mcp" && String(c[1]).includes("1/1")),
    ).toBe(true);
  });

  it("falls back to global settings when no project file exists", async () => {
    writeGlobalSettings({ mcp: { globalsrv: { type: "local", command: ["node", "g.js"] } } });
    const cwd = join(fakeHome, "proj-empty");
    mkdirSync(cwd, { recursive: true });

    await piMcpToolsFactory(harness.pi);
    await startSession(harness, cwd, true);

    const report = await listServersReport(harness);
    expect(report.servers).toHaveLength(1);
    expect(report.servers[0]).toMatchObject({ name: "globalsrv", source: "global settings", connected: true });
  });

  it("falls back to global-only when the project is not trusted, with untrusted-project ledger rows", async () => {
    writeGlobalSettings({ mcp: { globalsrv: { type: "local", command: ["node", "g.js"] } } });
    const cwd = join(fakeHome, "proj-untrusted");
    writeProjectMcpJson(cwd, { projsrv: { command: "node", args: ["p.js"] } });

    await piMcpToolsFactory(harness.pi);
    await startSession(harness, cwd, false);

    const report = await listServersReport(harness);
    const projEntry = report.servers.find((s: any) => s.name === "projsrv");
    expect(projEntry).toMatchObject({ name: "projsrv", source: "untrusted-project" });
    expect(projEntry.connected).toBeUndefined();
    expect(report.servers.find((s: any) => s.name === "globalsrv")).toMatchObject({
      source: "global settings",
      connected: true,
    });
    expect(report.untrustedCount).toBe(1);
    // Only the global server actually connected.
    expect(sdk.clients.length).toBe(1);
  });

  it("project config wins over global for the same server name", async () => {
    writeGlobalSettings({
      mcp: { hermes: { type: "local", command: ["global-hermes"] } },
    });
    const cwd = join(fakeHome, "proj-precedence");
    writeProjectMcpJson(cwd, { hermes: { command: "project-hermes", args: ["--flag"] } });

    await piMcpToolsFactory(harness.pi);
    await startSession(harness, cwd, true);

    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const lastCall = vi.mocked(StdioClientTransport).mock.calls.at(-1)![0] as any;
    expect(lastCall.command).toBe("project-hermes");
    expect(lastCall.args).toEqual(["--flag"]);

    const report = await listServersReport(harness);
    expect(report.servers[0]).toMatchObject({ name: "hermes", source: "project:.mcp.json" });
  });

  it("an unparseable project file yields global-only fallback plus a warning, never a partial arm", async () => {
    writeGlobalSettings({ mcp: { globalsrv: { type: "local", command: ["node", "g.js"] } } });
    const cwd = join(fakeHome, "proj-broken");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, ".mcp.json"), "{ not json at all", "utf-8");

    await piMcpToolsFactory(harness.pi);
    const ctx = await startSession(harness, cwd, true);

    const report = await listServersReport(harness);
    expect(report.servers).toHaveLength(1);
    expect(report.servers[0].name).toBe("globalsrv");
    expect(report.warnings.some((w: string) => w.includes("unparseable"))).toBe(true);
    const notifyCalls = (ctx.ui.notify as any).mock.calls.map((c: any[]) => String(c[0]));
    expect(notifyCalls.some((m: string) => m.includes("global settings"))).toBe(true);
  });

  it("skipped project entries are recorded in the ledger while good entries still arm", async () => {
    const cwd = join(fakeHome, "proj-mixed");
    writeProjectMcpJson(cwd, {
      good: { command: "node", args: ["g.js"] },
      broken: { type: "mystery" },
    });

    await piMcpToolsFactory(harness.pi);
    await startSession(harness, cwd, true);

    const report = await listServersReport(harness);
    expect(report.servers.find((s: any) => s.name === "good")).toMatchObject({
      source: "project:.mcp.json",
      connected: true,
    });
    expect(report.servers.find((s: any) => s.name === "broken")).toMatchObject({ source: "skipped:unsupported-shape" });
    expect(report.skippedCount).toBe(1);
    expect(sdk.clients.length).toBe(1);
  });

  it("re-derives config from ctx.cwd every session — never cached", async () => {
    const cwdA = join(fakeHome, "proj-a");
    const cwdB = join(fakeHome, "proj-b");
    writeProjectMcpJson(cwdA, { srvA: { command: "node", args: ["a.js"] } });
    writeProjectMcpJson(cwdB, { srvB: { command: "node", args: ["b.js"] } });

    await piMcpToolsFactory(harness.pi);
    await startSession(harness, cwdA, true);
    expect(listServersTool(harness)).toBeDefined();

    await harness.handlers.get("session_shutdown")!(shutdownEvent, createMockCtx(cwdA));
    await startSession(harness, cwdB, true);

    const report = await listServersReport(harness);
    const names = report.servers.map((s: any) => s.name);
    expect(names).toContain("srvB");
    expect(names).not.toContain("srvA");
    expect(report.servers.find((s: any) => s.name === "srvB")).toMatchObject({
      source: "project:.mcp.json",
      connected: true,
    });
  });

  it("session_shutdown tears down; a second session_start re-arms", async () => {
    const cwd = join(fakeHome, "proj-teardown");
    writeProjectMcpJson(cwd, { srv: { command: "node", args: ["s.js"] } });

    await piMcpToolsFactory(harness.pi);
    await startSession(harness, cwd, true);
    expect((await listServersReport(harness)).initialized).toBe(true);

    await harness.handlers.get("session_shutdown")!(shutdownEvent, createMockCtx(cwd));
    const afterShutdown = await listServersReport(harness);
    expect(afterShutdown.initialized).toBe(false);
    expect(afterShutdown.servers).toHaveLength(0);

    // Second session_start re-arms (same cwd, new session).
    await startSession(harness, cwd, true);
    const reArmed = await listServersReport(harness);
    expect(reArmed.initialized).toBe(true);
    expect(reArmed.servers).toHaveLength(1);
    expect(reArmed.servers[0].connected).toBe(true);
  });

  it("a second session_start without shutdown re-arms defensively", async () => {
    const cwd = join(fakeHome, "proj-rearm");
    writeProjectMcpJson(cwd, { srv: { command: "node", args: ["s.js"] } });

    await piMcpToolsFactory(harness.pi);
    await startSession(harness, cwd, true);
    await startSession(harness, cwd, true);

    const report = await listServersReport(harness);
    expect(report.initialized).toBe(true);
    expect(report.servers).toHaveLength(1);
    expect(report.servers[0].connected).toBe(true);
  });

  it("a converter error is logged and degrades to global-only, never thrown out of session_start", async () => {
    writeGlobalSettings({ mcp: { globalsrv: { type: "local", command: ["node", "g.js"] } } });
    const cwd = join(fakeHome, "proj-boom");
    writeProjectMcpJson(cwd, { projsrv: { command: "node", args: ["p.js"] } });

    const spy = vi.spyOn(ConfigLoader, "loadProjectMcpJson").mockImplementation(() => {
      throw new Error("converter exploded");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await piMcpToolsFactory(harness.pi);
      await expect(startSession(harness, cwd, true)).resolves.toBeDefined();

      const report = await listServersReport(harness);
      const degradeCall = consoleError.mock.calls.find((c) =>
        String(c[0]).includes("reading project .mcp.json failed"),
      );
      expect(degradeCall).toBeTruthy();
      expect((degradeCall![1] as Error).message).toBe("converter exploded");
      // Degraded, not dead: the global server still arms.
      expect(report.servers.find((s: any) => s.name === "globalsrv")).toMatchObject({
        source: "global settings",
        connected: true,
      });
      expect(report.servers.find((s: any) => s.name === "projsrv")).toBeUndefined();
    } finally {
      spy.mockRestore();
      consoleError.mockRestore();
    }
  });

  it("a factory error is swallowed (headless pi must not exit on a factory throw)", async () => {
    const cwd = join(fakeHome, "proj-factory");
    writeProjectMcpJson(cwd, { srv: { command: "node", args: ["s.js"] } });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const brokenHarness = createMockPi();
    (brokenHarness.raw.registerTool as any).mockImplementation(() => {
      throw new Error("registerTool exploded");
    });

    try {
      await expect(piMcpToolsFactory(brokenHarness.pi)).resolves.toBeUndefined();
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("a poison filter regex never kills the server (tools survive, warning logged)", async () => {
    writeGlobalSettings({
      mcp: { globbler: { type: "local", command: ["node", "x.js"], filterPatterns: ["(("] } },
    });
    sdk.tools = [
      { name: "tool_one", description: "one", inputSchema: { type: "object" } },
      { name: "tool_two", description: "two", inputSchema: { type: "object" } },
    ];
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await piMcpToolsFactory(harness.pi);
      await startSession(harness, join(fakeHome, "no-project"), true);

      const report = await listServersReport(harness);
      expect(report.servers[0]).toMatchObject({ name: "globbler", connected: true });
      expect(report.servers[0].error).toBeUndefined();
      // Fail-open: with no compilable pattern the tools are not hidden.
      expect(harness.tools.some((t) => t.name === "mcp_globbler_tool_one")).toBe(true);
      expect(harness.tools.some((t) => t.name === "mcp_globbler_tool_two")).toBe(true);
      expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining("(("));
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it("a per-server connect failure is visible in the report and notify without --mcp-debug", async () => {
    writeGlobalSettings({
      mcp: {
        deadsrv: { type: "local", command: ["node", "dead.js"] },
        alivesrv: { type: "local", command: ["node", "alive.js"] },
      },
    });
    sdk.failConnect = true; // every connect fails in this test

    await piMcpToolsFactory(harness.pi);
    const ctx = await startSession(harness, join(fakeHome, "no-project"), true);

    const report = await listServersReport(harness);
    const dead = report.servers.find((s: any) => s.name === "deadsrv");
    expect(dead).toMatchObject({ name: "deadsrv", source: "global settings", connected: false });
    expect(dead.error).toBeTruthy();

    // Failure surfaces without the debug flag.
    expect(harness.raw.getFlag).toHaveBeenCalledWith("mcp-debug");
    const notifyCalls = (ctx.ui.notify as any).mock.calls.map((c: any[]) => String(c[0]));
    expect(notifyCalls.some((m: string) => m.includes("deadsrv"))).toBe(true);
  });

  it("/mcp-status renders the same ledger", async () => {
    const cwd = join(fakeHome, "proj-status");
    writeProjectMcpJson(cwd, {
      good: { command: "node", args: ["g.js"] },
      broken: { type: "mystery" },
    });

    await piMcpToolsFactory(harness.pi);
    const ctx = await startSession(harness, cwd, true);

    const status = harness.commands.get("mcp-status");
    expect(status).toBeDefined();
    await status!.handler(null, ctx);

    const notifyCalls = (ctx.ui.notify as any).mock.calls.map((c: any[]) => String(c[0]));
    const ledgerRender = notifyCalls.find((m: string) => m.includes("ledger"));
    expect(ledgerRender).toBeTruthy();
    expect(ledgerRender).toContain("good");
    expect(ledgerRender).toContain("project:.mcp.json");
    expect(ledgerRender).toContain("skipped:unsupported-shape");
  });
});
