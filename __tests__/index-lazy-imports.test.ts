import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  loaded: [] as string[],
}));

function failIfImported(name: string): never {
  mocked.loaded.push(name);
  throw new Error(`${name} should be lazy-loaded after startup registration`);
}

vi.mock("../commands.ts", () => failIfImported("commands"));
vi.mock("../direct-tools.ts", () => failIfImported("direct-tools"));
vi.mock("../init.ts", () => failIfImported("init"));
vi.mock("../mcp-auth-flow.ts", () => failIfImported("mcp-auth-flow"));
vi.mock("../proxy-modes.ts", () => failIfImported("proxy-modes"));

function createPi() {
  return {
    registerTool: vi.fn(),
    registerFlag: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn(),
    getAllTools: vi.fn(() => []),
  } as any;
}

describe("mcpAdapter startup imports", () => {
  it("does not import heavy runtime modules while registering startup resources", async () => {
    const { default: mcpAdapter } = await import("../index.ts");
    const pi = createPi();

    mcpAdapter(pi);

    expect(mocked.loaded).toEqual([]);
    expect(pi.registerCommand).toHaveBeenCalledWith("mcp", expect.any(Object));
    expect(pi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "mcp" }));
  }, 60_000);
});
