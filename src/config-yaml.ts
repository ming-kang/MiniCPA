import crypto from "node:crypto";
import fs from "node:fs";
import YAML from "yaml";

export type CpaConfig = {
  host?: string;
  port?: number;
  "auth-dir"?: string;
  "api-keys"?: string[];
  "remote-management"?: {
    "secret-key"?: string;
    "panel-github-repository"?: string;
    "disable-auto-update-panel"?: boolean;
  };
};

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8317;
/** Well-known default from older MiniCPA templates — doctor warns if still present. */
export const LEGACY_DEFAULT_API_KEY = "sk-cliproxyapi";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coercePort(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    const n = Math.trunc(value);
    if (n >= 1 && n <= 65535) return n;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const n = Number.parseInt(value.trim(), 10);
    if (n >= 1 && n <= 65535) return n;
  }
  return DEFAULT_PORT;
}

function coerceHost(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  return DEFAULT_HOST;
}

function coerceApiKeys(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  return [];
}

/** Normalize a parsed YAML document into a safe CpaConfig (never throws on shape). */
export function normalizeCpaConfig(doc: unknown): CpaConfig {
  if (!isPlainObject(doc)) {
    return { host: DEFAULT_HOST, port: DEFAULT_PORT };
  }
  const remote = isPlainObject(doc["remote-management"])
    ? (doc["remote-management"] as Record<string, unknown>)
    : undefined;

  const config: CpaConfig = {
    host: coerceHost(doc.host),
    port: coercePort(doc.port),
  };

  if (typeof doc["auth-dir"] === "string") {
    config["auth-dir"] = doc["auth-dir"];
  }

  const keys = coerceApiKeys(doc["api-keys"]);
  if (keys !== undefined) config["api-keys"] = keys;

  if (remote) {
    config["remote-management"] = {};
    if (typeof remote["secret-key"] === "string") {
      config["remote-management"]["secret-key"] = remote["secret-key"];
    }
    if (typeof remote["panel-github-repository"] === "string") {
      config["remote-management"]["panel-github-repository"] = remote["panel-github-repository"];
    }
    if (typeof remote["disable-auto-update-panel"] === "boolean") {
      config["remote-management"]["disable-auto-update-panel"] =
        remote["disable-auto-update-panel"];
    }
  }

  return config;
}

export function readCpaConfig(configPath: string): CpaConfig {
  if (!fs.existsSync(configPath)) {
    return { host: DEFAULT_HOST, port: DEFAULT_PORT };
  }
  const text = fs.readFileSync(configPath, "utf8");
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch (err) {
    throw new Error(`Invalid YAML: ${(err as Error).message}`);
  }
  return normalizeCpaConfig(doc);
}

export function getListenAddress(config: CpaConfig): { host: string; port: number } {
  return {
    host: config.host ?? DEFAULT_HOST,
    port: config.port ?? DEFAULT_PORT,
  };
}

export function getPanelRepository(config: CpaConfig): string {
  return (
    config["remote-management"]?.["panel-github-repository"] ??
    "https://github.com/router-for-me/Cli-Proxy-API-Management-Center"
  );
}

export function generateApiKey(): string {
  return `sk-${crypto.randomBytes(18).toString("hex")}`;
}

export function defaultConfigYaml(apiKey: string = LEGACY_DEFAULT_API_KEY): string {
  return `# CLIProxyAPI configuration (managed by MiniCPA)
host: "127.0.0.1"
port: 8317

tls:
  enable: false
  cert: ""
  key: ""

remote-management:
  allow-remote: false
  secret-key: ""
  disable-control-panel: false
  panel-github-repository: "https://github.com/router-for-me/Cli-Proxy-API-Management-Center"

auth-dir: "auths"

api-keys:
  - ${apiKey}

debug: false
commercial-mode: true
logging-to-file: false
usage-statistics-enabled: true

proxy-url: ""

routing:
  strategy: "round-robin"

request-retry: 3
max-retry-credentials: 0
max-retry-interval: 30
`;
}
