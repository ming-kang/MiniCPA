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

export function readCpaConfig(configPath: string): CpaConfig {
  if (!fs.existsSync(configPath)) {
    return { host: DEFAULT_HOST, port: DEFAULT_PORT };
  }
  const doc = YAML.parse(fs.readFileSync(configPath, "utf8")) as CpaConfig | null;
  return doc ?? { host: DEFAULT_HOST, port: DEFAULT_PORT };
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

export function defaultConfigYaml(): string {
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
  - sk-cliproxyapi

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