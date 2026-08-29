import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// McpClient is mocked so close events can be simulated deterministically;
// the registry's reconnect scheduling is what is under test here.

interface MockMcpClient {
  config: unknown;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
  isConnected: ReturnType<typeof vi.fn>;
  onDisconnected?: (error?: Error) => void;
}

const state = vi.hoisted(() => ({
  instances: [] as any[],
  connectBehavior: () => Promise.resolve(),
}));

vi.mock("../src/McpClient.js", () => ({
  McpClient: vi.fn().mockImplementation((config: unknown) => {
    const instance = {
      config,
      connect: vi.fn(() => state.connectBehavior()),
      disconnect: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      listTools: vi.fn(async () => ({ tools: [] })),
      isConnected: vi.fn(() => true),
      onDisconnected: undefined,
    };
    state.instances.push(instance);
    return instance;
  }),
}));

import { McpRegistry } from "../src/McpRegistry.js";

const configs = [{ name: "srv", config: { type: "local" as const, command: ["node", "server.js"] } }];

describe("McpRegistry auto-reconnect", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    state.instances.length = 0;
    state.connectBehavior = () => Promise.resolve();
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    consoleError.mockRestore();
  });

  it("schedules a reconnect after reconnectInterval when a client closes unexpectedly", async () => {
    const registry = new McpRegistry(configs, true, 5000);
    await registry.initialize();
    expect(state.instances).toHaveLength(1);
    expect(state.instances[0].onDisconnected).toBeTypeOf("function");

    state.instances[0].onDisconnected!(new Error("pipe closed"));

    await vi.advanceTimersByTimeAsync(4999);
    expect(state.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(state.instances).toHaveLength(2);
    expect(state.instances[1].connect).toHaveBeenCalled();
  });

  it("gives up after MAX_RECONNECT_ATTEMPTS and logs it", async () => {
    const registry = new McpRegistry(configs, true, 5000);
    await registry.initialize();
    expect(state.instances[0].onDisconnected).toBeTypeOf("function");

    for (let i = 0; i < 10; i++) {
      state.instances[0].onDisconnected!(new Error("died"));
    }
    expect(consoleError).not.toHaveBeenCalled();

    state.instances[0].onDisconnected!(new Error("died again"));

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("max reconnect attempts (10) reached"),
    );
  });

  it("resets the attempt counter after a successful reconnect", async () => {
    const registry = new McpRegistry(configs, true, 5000);
    await registry.initialize();
    expect(state.instances[0].onDisconnected).toBeTypeOf("function");

    state.instances[0].onDisconnected!(new Error("died"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(state.instances).toHaveLength(2);

    // A fresh counter means ten more failures still do not hit the cap
    for (let i = 0; i < 10; i++) {
      state.instances[1].onDisconnected!(new Error("died"));
    }
    expect(consoleError).not.toHaveBeenCalledWith(
      expect.stringContaining("max reconnect attempts"),
    );
  });

  it("does not schedule reconnects when autoReconnect is disabled", async () => {
    const registry = new McpRegistry(configs, false, 5000);
    await registry.initialize();
    expect(state.instances[0].onDisconnected).toBeTypeOf("function");

    state.instances[0].onDisconnected!(new Error("died"));
    await vi.advanceTimersByTimeAsync(60000);

    expect(state.instances).toHaveLength(1);
  });

  it("shutdown cancels pending reconnect timers and suppresses later close events", async () => {
    const registry = new McpRegistry(configs, true, 5000);
    await registry.initialize();
    expect(state.instances[0].onDisconnected).toBeTypeOf("function");

    state.instances[0].onDisconnected!(new Error("died"));
    await registry.shutdown();

    state.instances[0].onDisconnected!(new Error("died again"));
    await vi.advanceTimersByTimeAsync(60000);

    expect(state.instances).toHaveLength(1);
  });

  it("replaces the pending reconnect timer instead of stacking duplicates", async () => {
    const registry = new McpRegistry(configs, true, 5000);
    await registry.initialize();
    expect(state.instances[0].onDisconnected).toBeTypeOf("function");

    state.instances[0].onDisconnected!(new Error("died"));
    await vi.advanceTimersByTimeAsync(1000);
    state.instances[0].onDisconnected!(new Error("died"));
    await vi.advanceTimersByTimeAsync(1000);
    state.instances[0].onDisconnected!(new Error("died"));

    await vi.advanceTimersByTimeAsync(5000);
    expect(state.instances).toHaveLength(2);
  });

  it("schedules a reconnect when healthCheck finds a server unhealthy", async () => {
    const registry = new McpRegistry(configs, true, 5000);
    await registry.initialize();
    expect(state.instances[0].onDisconnected).toBeTypeOf("function");

    state.instances[0].listTools.mockRejectedValue(new Error("dead"));
    const results = await registry.healthCheck();
    expect(results.get("srv")).toBe(false);

    await vi.advanceTimersByTimeAsync(5000);
    expect(state.instances).toHaveLength(2);
  });

  it("watches the replacement client created by a reconnect", async () => {
    const registry = new McpRegistry(configs, true, 5000);
    await registry.initialize();
    expect(state.instances[0].onDisconnected).toBeTypeOf("function");

    state.instances[0].onDisconnected!(new Error("died"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(state.instances).toHaveLength(2);

    expect(state.instances[1].onDisconnected).toBeTypeOf("function");
    state.instances[1].onDisconnected!(new Error("died again"));
    await vi.advanceTimersByTimeAsync(5000);
    expect(state.instances).toHaveLength(3);
  });
});

describe("McpRegistry healthCheck", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    state.instances.length = 0;
    state.connectBehavior = () => Promise.resolve();
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    consoleError.mockRestore();
  });

  it("marks a server unhealthy when listTools hangs past the health-check timeout", async () => {
    const registry = new McpRegistry(configs, false, 5000);
    await registry.initialize();
    state.instances[0].listTools = vi.fn(() => new Promise(() => {}));

    const check = registry.healthCheck();
    await vi.advanceTimersByTimeAsync(5000);
    const results = await check;

    expect(results.get("srv")).toBe(false);
  });

  it("marks a responsive server healthy", async () => {
    const registry = new McpRegistry(configs, false, 5000);
    await registry.initialize();

    const results = await registry.healthCheck();

    expect(results.get("srv")).toBe(true);
  });
});
