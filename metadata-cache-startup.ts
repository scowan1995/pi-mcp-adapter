import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { getAgentPath } from "./agent-dir.ts";
import { interpolateEnvRecord, resolveBearerToken, resolveConfigPath } from "./utils.ts";
import type { ServerEntry } from "./types.ts";

const CACHE_VERSION = 1;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface CachedTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  uiResourceUri?: string;
  uiStreamMode?: "eager" | "stream-first";
}

export interface CachedResource {
  uri: string;
  name: string;
  description?: string;
}

export interface ServerCacheEntry {
  configHash: string;
  tools: CachedTool[];
  resources: CachedResource[];
  cachedAt: number;
}

export interface MetadataCache {
  version: number;
  servers: Record<string, ServerCacheEntry>;
}

export function loadMetadataCache(): MetadataCache | null {
  const cachePath = getAgentPath("mcp-cache.json");
  if (!existsSync(cachePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(cachePath, "utf-8"));
    if (!raw || typeof raw !== "object") return null;
    if (raw.version !== CACHE_VERSION) return null;
    if (!raw.servers || typeof raw.servers !== "object") return null;
    return raw as MetadataCache;
  } catch {
    return null;
  }
}

export function isServerCacheValid(
  entry: ServerCacheEntry,
  definition: ServerEntry,
  maxAgeMs: number = CACHE_MAX_AGE_MS,
): boolean {
  if (!entry || entry.configHash !== computeServerHash(definition)) return false;
  if (!entry.cachedAt || typeof entry.cachedAt !== "number") return false;
  if (maxAgeMs > 0 && Date.now() - entry.cachedAt > maxAgeMs) return false;
  return true;
}

function computeServerHash(definition: ServerEntry): string {
  const identity: Record<string, unknown> = {
    command: definition.command,
    args: definition.args,
    env: interpolateEnvRecord(definition.env),
    cwd: resolveConfigPath(definition.cwd),
    url: definition.url,
    headers: interpolateEnvRecord(definition.headers),
    auth: definition.auth,
    bearerToken: resolveBearerToken(definition),
    bearerTokenEnv: definition.bearerTokenEnv,
    exposeResources: definition.exposeResources,
    excludeTools: definition.excludeTools,
  };
  const normalized = stableStringify(identity);
  return createHash("sha256").update(normalized).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "undefined" : serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map(v => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
