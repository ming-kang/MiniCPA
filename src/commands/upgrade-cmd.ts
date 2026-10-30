import { withMiniCpaLock, withMiniCpaUpdateLock } from "../process/lock.js";
import {
  compareMinicpaVersions,
  fetchLatestMinicpaVersion,
  type MinicpaVersionStatus,
} from "../update/minicpa-release.js";
import { detectNpmGlobalInstall } from "../update/npm-global-detection.js";
import { executeMinicpaUpgrade } from "../update/self-upgrade.js";

export type UpgradeCheckDeps = {
  fetchLatestMinicpaVersion: typeof fetchLatestMinicpaVersion;
  compareMinicpaVersions: typeof compareMinicpaVersions;
};

export type UpgradeDeps = UpgradeCheckDeps & {
  detectNpmGlobalInstall: typeof detectNpmGlobalInstall;
  executeMinicpaUpgrade: typeof executeMinicpaUpgrade;
  withMiniCpaLock: typeof withMiniCpaLock;
  withMiniCpaUpdateLock: typeof withMiniCpaUpdateLock;
};

const realUpgradeCheckDeps: UpgradeCheckDeps = {
  fetchLatestMinicpaVersion,
  compareMinicpaVersions,
};

const realUpgradeDeps: UpgradeDeps = {
  ...realUpgradeCheckDeps,
  detectNpmGlobalInstall,
  executeMinicpaUpgrade,
  withMiniCpaLock,
  withMiniCpaUpdateLock,
};

function printVersionStatus(
  currentVersion: string,
  latestVersion: string,
  status: MinicpaVersionStatus,
): void {
  if (status === "current") {
    console.log(`MiniCPA is already up to date (${currentVersion})`);
  } else if (status === "outdated") {
    console.log(`MiniCPA upgrade available: ${currentVersion} → ${latestVersion}`);
  } else {
    console.log(
      `MiniCPA is newer than the latest published version (${currentVersion} > ${latestVersion}). No changes made.`,
    );
  }
}

/** Check npm's latest MiniCPA version without inspecting the installation or taking a lock. */
export async function runUpgradeCheck(
  currentVersion: string,
  deps: UpgradeCheckDeps = realUpgradeCheckDeps,
): Promise<void> {
  const latestVersion = await deps.fetchLatestMinicpaVersion();
  const status = deps.compareMinicpaVersions(currentVersion, latestVersion);
  printVersionStatus(currentVersion, latestVersion, status);
  if (status === "outdated") console.log("Run: cpa upgrade");
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

  // A local version newer than npm's latest must never become a downgrade candidate,
  // including when --force was supplied.
  if (status === "ahead") {
    printVersionStatus(opts.currentVersion, latestVersion, status);
    return;
  }
  if (status === "current" && !opts.force) {
    printVersionStatus(opts.currentVersion, latestVersion, status);
    return;
  }
  if (status === "outdated") {
    printVersionStatus(opts.currentVersion, latestVersion, status);
  }

  // Do not replace package modules/templates while a binary update is preparing.
  await deps.withMiniCpaUpdateLock("upgrade", () =>
    deps.withMiniCpaLock("upgrade", async () => {
      const detection = await deps.detectNpmGlobalInstall(opts.packageRoot);
      if (!detection.supported) {
        throw new Error(
          [
            "MiniCPA cannot upgrade this installation automatically.",
            detection.message,
            "Upgrade manually with:",
            "npm install -g @astralyn/minicpa@latest",
          ].join("\n"),
        );
      }

      console.log(
        opts.force
          ? `Reinstalling MiniCPA ${latestVersion} with npm…`
          : "Upgrading MiniCPA with npm…",
      );
      await deps.executeMinicpaUpgrade(detection, latestVersion, opts.force ? "install" : "update");
    }),
  );

  console.log(
    opts.force
      ? `MiniCPA reinstalled: ${latestVersion}`
      : `MiniCPA upgraded: ${opts.currentVersion} → ${latestVersion}`,
  );
}
