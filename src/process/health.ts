import { getListenAddress, readCpaConfig } from "../config-yaml.js";
import { cpaLayout } from "../paths.js";

export async function waitForHttpOk(url: string, timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.ok || res.status === 304) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

export function managementUrl(home: string): string {
  const layout = cpaLayout(home);
  const cfg = readCpaConfig(layout.configFile);
  const { host, port } = getListenAddress(cfg);
  return `http://${host}:${port}/management.html`;
}

export function apiBaseUrl(home: string): string {
  const layout = cpaLayout(home);
  const cfg = readCpaConfig(layout.configFile);
  const { host, port } = getListenAddress(cfg);
  return `http://${host}:${port}`;
}