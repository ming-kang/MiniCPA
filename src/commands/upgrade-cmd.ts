import { withMiniCpaLock } from "../process/lock.js";
import {
  compareMinicpaVersions,
  fetchLatestMinicpaVersion,
  type MinicpaVersionStatus,
} from "../update/minicpa-release.js";
import { detectNpmGlobalInstall, installMinicpaVersion } from "../update/self-upgrade.js";

export type UpgradeCheckDeps = {
  fetchLatestMinicpaVersion: typeof fetchLatestMinicpaVersion;
  compareMinicpaVersions: typeof compareMinicpaVersions;
};

type UpgradeLock = <T>(command: string, fn: () => Promise<T>) => Promise<T>;

export type UpgradeDeps = UpgradeCheckDeps & {
  detectNpmGlobalInstall: typeof detectNpmGlobalInstall;
  installMinicpaVersion: typeof installMinicpaVersion;
  withMiniCpaLock: UpgradeLock;
};

const realUpgradeCheckDeps: UpgradeCheckDeps = {
  fetchLatestMinicpaVersion,
  compareMinicpaVersions,
};

const realUpgradeDeps: UpgradeDeps = {
  ...realUpgradeCheckDeps,
  detectNpmGlobalInstall,
  installMinicpaVersion,
  withMiniCpaLock,
};

function statusText(status: MinicpaVersionStatus): string {
  if (status === "current") return "up-to-date";
  if (status === "outdated") return "update available";
  return "ahead (will not downgrade)";
}

function printVersionStatus(
  currentVersion: string,
  latestVersion: string,
  status: MinicpaVersionStatus,
): void {
  console.log(`MiniCPA current=${currentVersion}  latest=${latestVersion}  ${statusText(status)}`);
}

/** Check npm's latest MiniCPA version without inspecting the installation or taking a lock. */
export async function runUpgradeCheck(
  currentVersion: string,
  deps: UpgradeCheckDeps = realUpgradeCheckDeps,
): Promise<void> {
  const latestVersion = await deps.fetchLatestMinicpaVersion();
  const status = deps.compareMinicpaVersions(currentVersion, latestVersion);
  printVersionStatus(currentVersion, latestVersion, status);
  process.exitCode = status === "outdated" ? 1 : 0;
}

/** Upgrade MiniCPA itself when this is a proven direct npm-global installation. */
export async function runUpgrade(
  opts: {
    currentVersion: string;
    packageRoot: string;
    force?: boolean;
  },
  deps: UpgradeDeps = realUpgradeDeps,
): Promise<void> {
  const latestVersion = await deps.fetchLatestMinicpaVersion();
  const status = deps.compareMinicpaVersions(opts.currentVersion, latestVersion);
  printVersionStatus(opts.currentVersion, latestVersion, status);

  // A local version newer than npm's latest must never become a downgrade candidate,
  // including when --force was supplied.
  if (status === "ahead") return;
  if (status === "current" && !opts.force) return;

  await deps.withMiniCpaLock("upgrade", async () => {
    const detection = await deps.detectNpmGlobalInstall(opts.packageRoot);
    if (!detection.supported) {
      throw new Error(
        [
          "MiniCPA self-upgrade supports only direct npm-global installations.",
          detection.message,
          "Install manually with:",
          "npm install -g @astralyn/minicpa@latest",
        ].join("\n"),
      );
    }

    await deps.installMinicpaVersion(detection, latestVersion);
  });

  console.log(
    status === "current"
      ? `MiniCPA reinstalled at ${latestVersion}`
      : `MiniCPA upgraded to ${latestVersion}`,
  );
}
