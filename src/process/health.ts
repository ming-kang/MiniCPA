import { getListenAddress, readCpaConfig } from "../config-yaml.js";
import { cpaLayout } from "../paths.js";
import { sleep } from "../util.js";

export async function waitForHttpOk(url: string, timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok || res.status === 304 || res.status === 401 || res.status === 403) {
        // Any HTTP response from CPA means the server is up (panel may require auth).
        return true;
      }
    } catch {
      /* retry */
    }
    await sleep(300);
  }
  return false;
}

export function managementUrl(home: string): string {
  const layout = cpaLayout(home);
  const cfg = readCpaConfig(layout.configFile);
  const { host, port } = getListenAddress(cfg);
  const h = host === "0.0.0.0" ? "127.0.0.1" : host;
  return `http://${h}:${port}/management.html`;
}

export function apiBaseUrl(home: string): string {
  const layout = cpaLayout(home);
  const cfg = readCpaConfig(layout.configFile);
  const { host, port } = getListenAddress(cfg);
  const h = host === "0.0.0.0" ? "127.0.0.1" : host;
  return `http://${h}:${port}`;
}

export function listenPort(home: string): number {
  const layout = cpaLayout(home);
  const cfg = readCpaConfig(layout.configFile);
  return getListenAddress(cfg).port;
}
