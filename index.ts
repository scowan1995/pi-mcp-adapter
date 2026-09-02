import type { AgentToolResult, ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { McpExtensionState } from "./state.ts";
import { Type } from "typebox";
import { loadMcpConfig } from "./config.ts";
import { buildProxyDescription, getMissingConfiguredDirectToolServers, resolveDirectTools } from "./direct-tools-startup.ts";
import { loadMetadataCache } from "./metadata-cache-startup.ts";
import { getConfigPathFromArgv, truncateAtWord } from "./utils.ts";

type ProxyToolResult = AgentToolResult<Record<string, unknown>>;

/** A newer session_start replaced this one before it began initializing. */
class StaleSessionStartError extends Error {
  constructor() {
    super("stale session_start");
    this.name = "StaleSessionStartError";
  }
}

function getNowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function addTimingToResult(
  result: ProxyToolResult,
  timing: { elapsedMs: number; startedAt: string; endedAt: string; mode: string },
): ProxyToolResult {
  const timingLine = `MCP timing: ${timing.elapsedMs.toFixed(1)} ms (${timing.mode})`;
  const lastTextIndex = result.content.map((block) => block.type).lastIndexOf("text");
  const content = result.content.map((block, index) => {
    if (index !== lastTextIndex || block.type !== "text") return block;
    return { ...block, text: `${block.text}\n\n${timingLine}` };
  });

  if (lastTextIndex === -1) {
    content.push({ type: "text", text: timingLine });
  }

  return {
    ...result,
    content,
    details: {
      ...(result.details ?? {}),
      timing,
    },
  };
}

function inferProxyMode(params: { tool?: string; connect?: string; describe?: string; search?: string; server?: string; action?: string }): string {
  if (params.action) return params.action;
  if (params.tool) return "call";
  if (params.connect) return "connect";
  if (params.describe) return "describe";
  if (params.search) return "search";
  if (params.server) return "list";
  return "status";
}

async function withOptionalTiming(
  includeTiming: boolean | undefined,
  mode: string,
  run: () => Promise<ProxyToolResult> | ProxyToolResult,
): Promise<ProxyToolResult> {
  if (!includeTiming) return run();

  const startedAt = new Date();
  const startedMs = getNowMs();
  const result = await run();
  const endedMs = getNowMs();
  const endedAt = new Date();
  return addTimingToResult(result, {
    elapsedMs: Math.max(0, endedMs - startedMs),
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    mode,
  });
}

export default function mcpAdapter(pi: ExtensionAPI) {
  let state: McpExtensionState | null = null;
  let initPromise: Promise<McpExtensionState> | null = null;
  let lifecycleGeneration = 0;

  async function shutdownState(currentState: McpExtensionState | null, reason: string): Promise<void> {
    if (!currentState) return;

    if (currentState.uiServer) {
      currentState.uiServer.close(reason);
      currentState.uiServer = null;
    }

    let flushError: unknown;
    try {
      const { flushMetadataCache } = await import("./init.ts");
      flushMetadataCache(currentState);
    } catch (error) {
      flushError = error;
    }

    try {
      await currentState.lifecycle.gracefulShutdown();
    } catch (error) {
      if (flushError) {
        console.error("MCP: graceful shutdown failed after metadata flush error", error);
      } else {
        throw error;
      }
    }

    if (flushError) {
      throw flushError;
    }
  }

  const earlyConfigPath = getConfigPathFromArgv();
  const earlyConfig = loadMcpConfig(earlyConfigPath);
  const earlyCache = loadMetadataCache();
  const prefix = earlyConfig.settings?.toolPrefix ?? "server";

  const envRaw = process.env.MCP_DIRECT_TOOLS;
  const directSpecs = envRaw === "__none__"
    ? []
    : resolveDirectTools(
        earlyConfig,
        earlyCache,
        prefix,
        envRaw?.split(",").map(s => s.trim()).filter(Boolean),
      );
  const missingConfiguredDirectToolServers = getMissingConfiguredDirectToolServers(earlyConfig, earlyCache);
  const shouldRegisterProxyTool =
    earlyConfig.settings?.disableProxyTool !== true
    || directSpecs.length === 0
    || missingConfiguredDirectToolServers.length > 0;

  for (const spec of directSpecs) {
    (pi.registerTool as (tool: unknown) => unknown)({
      name: spec.prefixedName,
      label: `MCP: ${spec.originalName}`,
      description: spec.description || "(no description)",
      promptSnippet: truncateAtWord(spec.description, 100) || `MCP tool from ${spec.serverName}`,
      parameters: Type.Unsafe((spec.inputSchema || { type: "object", properties: {} }) as never),
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const { createDirectToolExecutor } = await import("./direct-tools.ts");
        return createDirectToolExecutor(() => state, () => initPromise, spec)(toolCallId, params, signal, onUpdate, ctx);
      },
    });
  }

  const getPiTools = (): ToolInfo[] => pi.getAllTools();

  pi.registerFlag("mcp-config", {
    description: "Path to MCP config file",
    type: "string",
  });

  // Pi awaits session_start handlers, so nothing here may block: loading
  // ./init.ts pulls in @modelcontextprotocol/sdk and zod, ~3.5s of module
  // evaluation. The handler returns at once and initPromise covers the
  // imports too, so tool calls and /mcp wait instead of seeing "not
  // initialized".
  pi.on("session_start", (_event, ctx) => {
    const generation = ++lifecycleGeneration;
    const previousState = state;
    state = null;
    initPromise = null;

    const promise = (async () => {
      try {
        await Promise.all([
          shutdownState(previousState, "session_restart"),
          import("./mcp-auth-flow.ts").then(({ shutdownOAuth }) => shutdownOAuth()),
        ]);
      } catch (error) {
        console.error("MCP: failed to shut down previous session state", error);
      }

      if (generation !== lifecycleGeneration) {
        throw new StaleSessionStartError();
      }

      const [{ initializeOAuth }, { initializeMcp, updateStatusBar }] = await Promise.all([
        import("./mcp-auth-flow.ts"),
        import("./init.ts"),
      ]);

      await initializeOAuth().catch(err => {
        console.error("MCP OAuth initialization failed:", err);
      });

      const nextState = await initializeMcp(pi, ctx);

      if (generation !== lifecycleGeneration || initPromise !== promise) {
        try {
          await shutdownState(nextState, "stale_session_start");
        } catch (error) {
          console.error("MCP: failed to clean stale session state", error);
        }
        return nextState;
      }

      state = nextState;
      updateStatusBar(nextState);
      initPromise = null;
      return nextState;
    })();

    initPromise = promise;

    promise.catch(err => {
      if (err instanceof StaleSessionStartError) {
        return;
      }
      if (generation !== lifecycleGeneration) {
        return;
      }
      if (initPromise !== promise && initPromise !== null) {
        return;
      }
      console.error("MCP initialization failed:", err);
      initPromise = null;
    });
  });

  pi.on("session_shutdown", async () => {
    ++lifecycleGeneration;
    const currentState = state;
    state = null;
    initPromise = null;

    try {
      await Promise.all([
        shutdownState(currentState, "session_shutdown"),
        import("./mcp-auth-flow.ts").then(({ shutdownOAuth }) => shutdownOAuth()),
      ]);
    } catch (error) {
      console.error("MCP: session shutdown cleanup failed", error);
    }
  });

  pi.registerCommand("mcp", {
    description: "Show MCP server status",
    handler: async (args, ctx) => {
      if (!state && initPromise) {
        try {
          state = await initPromise;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (ctx.hasUI) ctx.ui.notify(`MCP initialization failed: ${message}`, "error");
          return;
        }
      }
      if (!state) {
        if (ctx.hasUI) ctx.ui.notify("MCP not initialized", "error");
        return;
      }

      const parts = args?.trim()?.split(/\s+/) ?? [];
      const subcommand = parts[0] ?? "";
      const targetServer = parts[1];
      const rest = parts.slice(1).join(" ");

      const commands = await import("./commands.ts");
      switch (subcommand) {
        case "reconnect":
          await commands.reconnectServers(state, ctx, targetServer);
          break;
        case "tools":
          await commands.showTools(state, ctx);
          break;
        case "setup": {
          const result = await commands.openMcpSetup(state, pi, ctx, earlyConfigPath, "setup");
          if (result?.configChanged) {
            await ctx.reload();
            return;
          }
          break;
        }
        case "logout": {
          const serverName = rest;
          if (!serverName) {
            if (ctx.hasUI) ctx.ui.notify("Usage: /mcp logout <server>", "error");
            return;
          }
          await commands.logoutServer(serverName, state, ctx);
          break;
        }
        case "status":
        case "":
        default:
          if (ctx.hasUI) {
            const result = await commands.openMcpPanel(state, pi, ctx, earlyConfigPath);
            if (result?.configChanged) {
              await ctx.reload();
              return;
            }
          } else {
            await commands.showStatus(state, ctx);
          }
          break;
      }
    },
  });

  pi.registerCommand("mcp-auth", {
    description: "Authenticate with an MCP server (OAuth)",
    handler: async (args, ctx) => {
      const serverName = args?.trim();
      if (!serverName && !ctx.hasUI) {
        return;
      }

      if (!state && initPromise) {
        try {
          state = await initPromise;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (ctx.hasUI) ctx.ui.notify(`MCP initialization failed: ${message}`, "error");
          return;
        }
      }
      if (!state) {
        if (ctx.hasUI) ctx.ui.notify("MCP not initialized", "error");
        return;
      }

      if (!serverName) {
        const { openMcpAuthPanel } = await import("./commands.ts");
        await openMcpAuthPanel(state, pi, ctx, earlyConfigPath);
        return;
      }

      const { authenticateServer } = await import("./commands.ts");
      await authenticateServer(serverName, state.config, ctx);
    },
  });

  if (shouldRegisterProxyTool) {
    (pi.registerTool as (tool: unknown) => unknown)({
      name: "mcp",
      label: "MCP",
      description: buildProxyDescription(earlyConfig, earlyCache, directSpecs),
      promptSnippet: "MCP gateway - connect to MCP servers and call their tools",
      parameters: Type.Object({
        tool: Type.Optional(Type.String({ description: "Tool name to call (e.g., 'xcodebuild_list_sims')" })),
        args: Type.Optional(Type.String({ description: "Arguments as JSON string (e.g., '{\"key\": \"value\"}')" })),
        connect: Type.Optional(Type.String({ description: "Server name to connect (lazy connect + metadata refresh)" })),
        describe: Type.Optional(Type.String({ description: "Tool name to describe (shows parameters)" })),
        search: Type.Optional(Type.String({ description: "Search tools by name/description" })),
        regex: Type.Optional(Type.Boolean({ description: "Treat search as regex (default: substring match)" })),
        includeSchemas: Type.Optional(Type.Boolean({ description: "Include parameter schemas in search results (default: true)" })),
        server: Type.Optional(Type.String({ description: "Filter to specific server (also disambiguates tool calls)" })),
        action: Type.Optional(Type.String({ description: "Action: 'ui-messages', 'auth-start', or 'auth-complete'" })),
        includeTiming: Type.Optional(Type.Boolean({ description: "Include MCP proxy call duration in the result (default: false)" })),
      }),
      async execute(_toolCallId, params: {
        tool?: string;
        args?: string;
        connect?: string;
        describe?: string;
        search?: string;
        regex?: boolean;
        includeSchemas?: boolean;
        server?: string;
        action?: string;
        includeTiming?: boolean;
      }, _signal, _onUpdate, _ctx) {
        let parsedArgs: Record<string, unknown> | undefined;
        if (params.args) {
          try {
            parsedArgs = JSON.parse(params.args);
            if (typeof parsedArgs !== "object" || parsedArgs === null || Array.isArray(parsedArgs)) {
              const gotType = Array.isArray(parsedArgs) ? "array" : parsedArgs === null ? "null" : typeof parsedArgs;
              throw new Error(`Invalid args: expected a JSON object, got ${gotType}`);
            }
          } catch (error) {
            if (error instanceof SyntaxError) {
              throw new Error(`Invalid args JSON: ${error.message}`, { cause: error });
            }
            throw error;
          }
        }

        if (!state && initPromise) {
          try {
            state = await initPromise;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              content: [{ type: "text" as const, text: `MCP initialization failed: ${message}` }],
              details: { error: "init_failed", message },
            };
          }
        }
        if (!state) {
          return {
            content: [{ type: "text" as const, text: "MCP not initialized" }],
            details: { error: "not_initialized" },
          };
        }

        const mode = inferProxyMode(params);
        return withOptionalTiming(params.includeTiming, mode, async () => {
          const proxyModes = await import("./proxy-modes.ts");
          if (params.action === "ui-messages") {
            return proxyModes.executeUiMessages(state);
          }
          if (params.action === "auth-start") {
            if (!params.server) {
              return {
                content: [{ type: "text" as const, text: "auth-start requires `server`. Example: mcp({ action: \"auth-start\", server: \"linear-server\" })" }],
                details: { mode: "auth-start", error: "missing_server" },
              };
            }
            return proxyModes.executeAuthStart(state, params.server);
          }
          if (params.action === "auth-complete") {
            if (!params.server) {
              return {
                content: [{ type: "text" as const, text: "auth-complete requires `server`." }],
                details: { mode: "auth-complete", error: "missing_server" },
              };
            }
            const input = parsedArgs?.redirectUrl ?? parsedArgs?.code ?? parsedArgs?.input;
            if (typeof input !== "string" || input.trim().length === 0) {
              return {
                content: [{ type: "text" as const, text: "auth-complete requires args with `redirectUrl`, `code`, or `input`." }],
                details: { mode: "auth-complete", error: "missing_input" },
              };
            }
            return proxyModes.executeAuthComplete(state, params.server, input);
          }
          if (params.tool) {
            return proxyModes.executeCall(state, params.tool, parsedArgs, params.server, getPiTools);
          }
          if (params.connect) {
            return proxyModes.executeConnect(state, params.connect);
          }
          if (params.describe) {
            return proxyModes.executeDescribe(state, params.describe);
          }
          if (params.search) {
            return proxyModes.executeSearch(state, params.search, params.regex, params.server, params.includeSchemas);
          }
          if (params.server) {
            return proxyModes.executeList(state, params.server);
          }
          return proxyModes.executeStatus(state);
        });
      },
    });
  }
}
