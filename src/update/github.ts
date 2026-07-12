export type GhRelease = {
  tag_name: string;
  name: string;
  published_at: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
    digest?: string;
  }>;
};

const CPA_REPO = "router-for-me/CLIProxyAPI";

export async function fetchLatestRelease(repo: string): Promise<GhRelease> {
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "MiniCPA",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} for ${repo}`);
  }
  return (await res.json()) as GhRelease;
}

export async function fetchLatestCpaRelease(): Promise<GhRelease> {
  return fetchLatestRelease(CPA_REPO);
}

export function repoFromPanelUrl(panelRepoUrl: string): string {
  const m = panelRepoUrl.match(/github\.com\/([^/]+\/[^/]+)/i);
  if (!m) throw new Error(`Unsupported panel repository URL: ${panelRepoUrl}`);
  return m[1]!.replace(/\.git$/, "");
}

export function normalizeTagVersion(tag: string): string {
  return tag.replace(/^v/, "");
}

export async function downloadToFile(url: string, dest: string): Promise<void> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = { "User-Agent": "MiniCPA" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
}

export function pickReleaseAsset(
  release: GhRelease,
  platform: NodeJS.Platform,
  arch: string,
): { assetName: string; url: string } {
  const version = normalizeTagVersion(release.tag_name);
  const candidates: string[] = [];

  if (platform === "win32") {
    if (arch === "arm64") candidates.push(`CLIProxyAPI_${version}_windows_arm64.zip`);
    candidates.push(`CLIProxyAPI_${version}_windows_amd64.zip`);
  } else if (platform === "darwin") {
    if (arch === "arm64") candidates.push(`CLIProxyAPI_${version}_darwin_aarch64.tar.gz`);
    candidates.push(`CLIProxyAPI_${version}_darwin_amd64.tar.gz`);
  } else {
    if (arch === "arm64") candidates.push(`CLIProxyAPI_${version}_linux_arm64.tar.gz`);
    candidates.push(`CLIProxyAPI_${version}_linux_amd64.tar.gz`);
    candidates.push(`CLIProxyAPI_${version}_linux_amd64_portable.tar.gz`);
  }

  for (const name of candidates) {
    const asset = release.assets.find((a) => a.name === name);
    if (asset) return { assetName: asset.name, url: asset.browser_download_url };
  }

  throw new Error(
    `No release asset for ${platform}/${arch}. Tried: ${candidates.join(", ")}`,
  );
}

export async function fetchChecksums(release: GhRelease): Promise<Map<string, string>> {
  const asset = release.assets.find((a) => a.name === "checksums.txt");
  if (!asset) return new Map();

  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = { "User-Agent": "MiniCPA" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(asset.browser_download_url, { headers });
  if (!res.ok) return new Map();

  const text = await res.text();
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^([a-f0-9]{64})\s+(.+)$/i);
    if (m) map.set(m[2]!.trim(), m[1]!.toLowerCase());
  }
  return map;
}