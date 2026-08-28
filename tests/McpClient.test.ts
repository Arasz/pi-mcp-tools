import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpClient } from "../src/McpClient.js";

// We test McpClient's disconnect/reconnect/connect logic
// without an actual MCP server by intercepting the SDK client.

const sdk = vi.hoisted(() => ({ clients: [] as any[] }));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => {
    const instance = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
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

describe("McpClient", () => {
  beforeEach(() => {
    sdk.clients.length = 0;
  });

  it("connects via stdio transport for local config", async () => {
    const config = { type: "local" as const, command: ["node", "server.js"] };
    const client = new McpClient(config);
    await client.connect();
    expect(client.isConnected()).toBe(true);
  });

  it("disconnect transitions to not-connected", async () => {
    const config = { type: "local" as const, command: ["node", "server.js"] };
    const client = new McpClient(config);
    await client.connect();
    expect(client.isConnected()).toBe(true);
    await client.disconnect();
    expect(client.isConnected()).toBe(false);
  });

  it("reconnect re-establishes connection", async () => {
    const config = { type: "local" as const, command: ["node", "server.js"] };
    const client = new McpClient(config);
    await client.connect();
    expect(client.isConnected()).toBe(true);
    await client.reconnect();
    expect(client.isConnected()).toBe(true);
  });

  it("listTools throws when not connected", async () => {
    const config = { type: "local" as const, command: ["node", "server.js"] };
    const client = new McpClient(config);
    await expect(client.listTools()).rejects.toThrow("not connected");
  });

  it("callTool throws when not connected", async () => {
    const config = { type: "local" as const, command: ["node", "server.js"] };
    const client = new McpClient(config);
    await expect(client.callTool("test", {})).rejects.toThrow("not connected");
  });

  it("isConnected() returns false before connect", () => {
    const config = { type: "local" as const, command: ["node", "server.js"] };
    const client = new McpClient(config);
    expect(client.isConnected()).toBe(false);
  });

  it("listTools succeeds after connect", async () => {
    const config = { type: "local" as const, command: ["node", "server.js"] };
    const client = new McpClient(config);
    await client.connect();
    const tools = await client.listTools();
    expect(Array.isArray(tools)).toBe(true);
  });

  it("callTool succeeds after connect", async () => {
    const config = { type: "local" as const, command: ["node", "server.js"] };
    const client = new McpClient(config);
    await client.connect();
    const result = await client.callTool("test", { arg: 1 });
    expect(result).toBeDefined();
  });

  it("handles remote config with explicit websocket transport", async () => {
    const config = { type: "remote" as const, url: "ws://localhost:8080/mcp" };
    const client = new McpClient(config);
    await client.connect();
    expect(client.isConnected()).toBe(true);
  });

  it("reconnect() constructs a fresh SDK Client after disconnect", async () => {
    const config = { type: "local" as const, command: ["node", "server.js"] };
    const client = new McpClient(config);
    await client.connect();
    await client.disconnect();
    vi.mocked(Client).mockClear();

    await client.reconnect();

    expect(vi.mocked(Client).mock.calls.length).toBe(1);
  });

  it("fires onDisconnected when the connection closes unexpectedly", async () => {
    const config = { type: "local" as const, command: ["node", "server.js"] };
    const client = new McpClient(config);
    const onDisconnected = vi.fn();
    client.onDisconnected = onDisconnected;
    await client.connect();
    const sdkClient = sdk.clients[sdk.clients.length - 1];

    sdkClient.onclose();

    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(client.isConnected()).toBe(false);
  });

  it("does not fire onDisconnected when disconnect() is intentional", async () => {
    const config = { type: "local" as const, command: ["node", "server.js"] };
    const client = new McpClient(config);
    const onDisconnected = vi.fn();
    client.onDisconnected = onDisconnected;
    await client.connect();
    const sdkClient = sdk.clients[sdk.clients.length - 1];
    // Server-death semantics: closing fires the SDK's onclose callback
    sdkClient.close.mockImplementation(async () => {
      sdkClient.onclose();
    });

    await client.disconnect();

    expect(onDisconnected).not.toHaveBeenCalled();
  });

  it("fires onDisconnected only once when onclose and onerror both fire", async () => {
    const config = { type: "local" as const, command: ["node", "server.js"] };
    const client = new McpClient(config);
    const onDisconnected = vi.fn();
    client.onDisconnected = onDisconnected;
    await client.connect();
    const sdkClient = sdk.clients[sdk.clients.length - 1];

    sdkClient.onerror(new Error("transport broke"));
    sdkClient.onclose();

    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(client.isConnected()).toBe(false);
  });
});