import { beforeEach, describe, expect, it, vi } from "vitest";

// `init.ts` stands in for the real module graph it pulls in
// (@modelcontextprotocol/sdk + zod), which costs ~3.5s to evaluate.
// The gate lets a test hold that evaluation open. Each test gets a fresh
// gate, since resetModules re-runs the mock factory.
const mocks = vi.hoisted(() => {
  const holder = {
    open: undefined as unknown as () => void,
    gate: undefined as unknown as Promise<void>,
  };
  const resetGate = () => {
    holder.gate = new Promise<void>((resolve) => {
      holder.open = resolve;
    });
  };
  resetGate();
  return {
    resetGate,
    awaitGate: () => holder.gate,
    openGate: () => holder.open(),
    initializeMcp: vi.fn(),
    updateStatusBar: vi.fn(),
    flushMetadataCache: vi.fn(),
    initializeOAuth: vi.fn().mockResolvedValue(undefined),
    shutdownOAuth: vi.fn().mockResolvedValue(undefined),
    executeStatus: vi.fn(),
  };
});

vi.mock("../init.ts", async () => {
  await mocks.awaitGate();
  return {
    initializeMcp: mocks.initializeMcp,
    updateStatusBar: mocks.updateStatusBar,
    flushMetadataCache: mocks.flushMetadataCache,
  };
});

vi.mock("../mcp-auth-flow.ts", () => ({
  initializeOAuth: mocks.initializeOAuth,
  shutdownOAuth: mocks.shutdownOAuth,
}));

vi.mock("../proxy-modes.ts", () => ({
  executeStatus: mocks.executeStatus,
  executeAuthComplete: vi.fn(),
  executeAuthStart: vi.fn(),
  executeCall: vi.fn(),
  executeConnect: vi.fn(),
  executeDescribe: vi.fn(),
  executeList: vi.fn(),
  executeSearch: vi.fn(),
  executeUiMessages: vi.fn(),
}));

vi.mock("../config.ts", () => ({
  loadMcpConfig: vi.fn(() => ({ mcpServers: {} })),
}));

vi.mock("../metadata-cache-startup.ts", () => ({
  loadMetadataCache: vi.fn(() => null),
}));

vi.mock("../direct-tools-startup.ts", () => ({
  buildProxyDescription: vi.fn(() => "MCP gateway"),
  getMissingConfiguredDirectToolServers: vi.fn(() => []),
  resolveDirectTools: vi.fn(() => []),
}));

function createPi() {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  return {
    handlers,
    api: {
      registerTool: vi.fn(),
      registerFlag: vi.fn(),
      registerCommand: vi.fn(),
      on: vi.fn((event: string, handler: (...args: any[]) => unknown) => {
        handlers.set(event, handler);
      }),
      getAllTools: vi.fn(() => []),
      getFlag: vi.fn(() => undefined),
    } as any,
  };
}

async function nextMacrotask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("mcpAdapter session_start does not block startup", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.resetGate();
    mocks.initializeMcp.mockReset();
    mocks.executeStatus.mockReset();
  });

  it("settles before the MCP module graph finishes loading", async () => {
    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    const sessionStart = handlers.get("session_start")!;
    let settled = false;
    void Promise.resolve(sessionStart({}, {})).then(() => {
      settled = true;
    });

    await nextMacrotask();

    expect(settled).toBe(true);
    expect(mocks.initializeMcp).not.toHaveBeenCalled();
  }, 60_000);

  it("still serves a tool call issued before initialization completes", async () => {
    const state = { manager: { getAllConnections: () => new Map() } } as any;
    mocks.initializeMcp.mockResolvedValue(state);
    mocks.executeStatus.mockResolvedValue({ content: [{ type: "text", text: "status ok" }] });

    const { default: mcpAdapter } = await import("../index.ts");
    const { api, handlers } = createPi();
    mcpAdapter(api);

    void handlers.get("session_start")!({}, {});
    await nextMacrotask();

    const proxyTool = api.registerTool.mock.calls.find((call: any[]) => call[0].name === "mcp")?.[0];
    const callResult = proxyTool.execute("call-1", {});

    mocks.openGate();

    await expect(callResult).resolves.toMatchObject({
      content: [{ type: "text", text: "status ok" }],
    });
    expect(mocks.executeStatus).toHaveBeenCalledWith(state);
  }, 60_000);
});
