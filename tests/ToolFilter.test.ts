import { describe, it, expect } from "vitest";
import { enabledToolNames } from "../src/toolFilter.js";

describe("enabledToolNames", () => {
  it("removes a disabled tool with a non-mcp_ prefix", () => {
    const registered = new Set(["gh_add_issue"]);
    const disabled = new Set(["gh_add_issue"]);
    const result = enabledToolNames(["gh_add_issue", "read_file"], registered, disabled);
    expect(result).toEqual(["read_file"]);
  });

  it("keeps a non-MCP tool whose name collides with a disabledTools entry", () => {
    const registered = new Set(["mcp_fs_read"]);
    const disabled = new Set(["read_file"]);
    const result = enabledToolNames(["mcp_fs_read", "read_file"], registered, disabled);
    expect(result).toEqual(["mcp_fs_read", "read_file"]);
  });

  it("keeps the default mcp_<server> behavior for registered tools", () => {
    const registered = new Set(["mcp_fs_read", "mcp_fs_write"]);
    const disabled = new Set(["mcp_fs_write"]);
    const result = enabledToolNames(["mcp_fs_read", "mcp_fs_write"], registered, disabled);
    expect(result).toEqual(["mcp_fs_read"]);
  });
});
