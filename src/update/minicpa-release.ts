import { compare, valid } from "semver";
import { httpFetch } from "../http.js";

export const MINICPA_PACKAGE_NAME = "@astralyn/minicpa";
export const NPM_REGISTRY_BASE_URL = "https://registry.npmjs.org";

const NPM_METADATA_MAX_BYTES = 64 * 1024;
const NPM_REGISTRY_TIMEOUT_MS = 15_000;
const NPM_REGISTRY_RETRIES = 2;
const EXACT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export type MinicpaVersionStatus = "current" | "outdated" | "ahead";

type NpmLatestMetadata = {
  name?: unknown;
  version?: unknown;
};

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "[::1]";
}

/**
 * Build the npm `latest` endpoint for MiniCPA's scoped package.
 * The registry override is internal/test-only and is restricted to loopback URLs.
 */
export function minicpaLatestMetadataUrl(registryBaseUrl: string = NPM_REGISTRY_BASE_URL): string {
  let registry: URL;
  try {
    registry = new URL(registryBaseUrl);
  } catch {
    throw new Error(`Invalid npm registry base URL: ${registryBaseUrl}`);
  }

  const isOfficialRegistry =
    registry.protocol === "https:" &&
    registry.hostname === "registry.npmjs.org" &&
    registry.port === "" &&
    (registry.pathname === "/" || registry.pathname === "") &&
    registry.username === "" &&
    registry.password === "" &&
    registry.search === "" &&
    registry.hash === "";
  const isTestRegistry =
    (registry.protocol === "http:" || registry.protocol === "https:") &&
    isLoopbackHostname(registry.hostname) &&
    registry.username === "" &&
    registry.password === "" &&
    registry.search === "" &&
    registry.hash === "";

  if (!isOfficialRegistry && !isTestRegistry) {
    throw new Error(
      `Refusing untrusted npm registry ${registryBaseUrl}. MiniCPA uses ${NPM_REGISTRY_BASE_URL}; only loopback overrides are allowed for tests.`,
    );
  }

  const base = registry.toString().replace(/\/$/, "");
  const encodedPackageName = MINICPA_PACKAGE_NAME.replace("/", "%2F");
  return `${base}/${encodedPackageName}/latest`;
}

function assertExactSemver(version: unknown, source: "current" | "latest"): string {
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(
      `${source === "latest" ? "npm registry metadata is missing a string version" : "Current MiniCPA version is missing"}. Expected an exact semver such as 1.2.3.`,
    );
  }
  if (!EXACT_SEMVER.test(version) || valid(version) === null) {
    throw new Error(
      `Invalid ${source} MiniCPA version "${version}". Expected a canonical exact semver such as 1.2.3 or 1.2.3-beta.1.`,
    );
  }
  return version;
}

async function cancelBody(response: Awaited<ReturnType<typeof httpFetch>>): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The status/size error is more useful than a cancellation failure.
  }
}

async function readMetadataBody(
  response: Awaited<ReturnType<typeof httpFetch>>,
  requestUrl: string,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > NPM_METADATA_MAX_BYTES) {
      await cancelBody(response);
      throw new Error(
        `npm registry metadata for ${MINICPA_PACKAGE_NAME} exceeds the ${NPM_METADATA_MAX_BYTES}-byte limit (${requestUrl}).`,
      );
    }
  }

  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > NPM_METADATA_MAX_BYTES) {
        await reader.cancel();
        throw new Error(
          `npm registry metadata for ${MINICPA_PACKAGE_NAME} exceeds the ${NPM_METADATA_MAX_BYTES}-byte limit (${requestUrl}).`,
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("exceeds the")) throw error;
    throw new Error(`Failed to read npm registry metadata from ${requestUrl}. Retry the request.`, {
      cause: error,
    });
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

/** Fetch and validate the version behind npm's `latest` dist-tag. */
export async function fetchLatestMinicpaVersion(
  registryBaseUrl: string = NPM_REGISTRY_BASE_URL,
): Promise<string> {
  const requestUrl = minicpaLatestMetadataUrl(registryBaseUrl);
  const response = await httpFetch(
    requestUrl,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": "MiniCPA",
      },
      signal: AbortSignal.timeout(NPM_REGISTRY_TIMEOUT_MS),
    },
    {
      retries: NPM_REGISTRY_RETRIES,
      minDelayMs: 250,
      maxDelayMs: 1_000,
    },
  );

  if (response.status === 404) {
    await cancelBody(response);
    throw new Error(
      `MiniCPA package ${MINICPA_PACKAGE_NAME} was not found in the npm registry (HTTP 404). Check the package name and registry availability.`,
    );
  }
  if (!response.ok) {
    await cancelBody(response);
    throw new Error(
      `npm registry request for ${MINICPA_PACKAGE_NAME} failed with HTTP ${response.status}. Retry later or check your network/proxy settings.`,
    );
  }

  const body = await readMetadataBody(response, requestUrl);
  let metadata: unknown;
  try {
    metadata = JSON.parse(body);
  } catch (error) {
    throw new Error(
      `npm registry returned invalid JSON for ${MINICPA_PACKAGE_NAME}. Retry later or check whether a proxy altered the response.`,
      { cause: error },
    );
  }

  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    throw new Error(
      `npm registry returned invalid metadata for ${MINICPA_PACKAGE_NAME}: expected a JSON object.`,
    );
  }

  const latest = metadata as NpmLatestMetadata;
  if (latest.name !== MINICPA_PACKAGE_NAME) {
    const actualName = typeof latest.name === "string" ? `"${latest.name}"` : "a missing name";
    throw new Error(
      `npm registry package name mismatch: expected "${MINICPA_PACKAGE_NAME}", received ${actualName}. Refusing to use this metadata.`,
    );
  }
  return assertExactSemver(latest.version, "latest");
}

/** Compare exact semvers without ever treating a newer local version as a downgrade candidate. */
export function compareMinicpaVersions(
  currentVersion: string,
  latestVersion: string,
): MinicpaVersionStatus {
  const current = assertExactSemver(currentVersion, "current");
  const latest = assertExactSemver(latestVersion, "latest");
  const ordering = compare(current, latest);
  if (ordering < 0) return "outdated";
  if (ordering > 0) return "ahead";
  return "current";
}
