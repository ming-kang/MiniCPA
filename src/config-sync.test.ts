import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import YAML from "yaml";
import { mergeCpaConfigYaml, syncCpaConfigDefaults } from "./config-sync.js";
import { defaultConfigYaml } from "./config-yaml.js";

const temps: string[] = [];

const TEMPLATE = `# canonical root comment
host: "127.0.0.1"
nested:
  # canonical enabled comment
  enabled: false
  count: 2
list:
  - "template"
nullable: "value"
`;

const EXISTING = `# obsolete root comment
list: []
nested:
  count: 9
  extra: keep
host: "0.0.0.0"
custom:
  retained: true
nullable:
`;

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("mergeCpaConfigYaml", () => {
  it("uses canonical policy, comments, and ordering while preserving local values and extras", () => {
    const merged = mergeCpaConfigYaml(EXISTING, TEMPLATE);
    const config = YAML.parse(merged.yaml) as Record<string, unknown>;

    assert.deepEqual(merged.addedPaths, ["nested.enabled"]);
    assert.deepEqual(merged.overwrittenPaths, ["nested.count", "list", "nullable"]);
    assert.deepEqual(config, {
      host: "0.0.0.0",
      nested: { enabled: false, count: 2, extra: "keep" },
      list: ["template"],
      nullable: "value",
      custom: { retained: true },
    });
    assert.match(merged.yaml, /^# canonical root comment/);
    assert.match(merged.yaml, /# canonical enabled comment/);
    assert.doesNotMatch(merged.yaml, /obsolete root comment/);
    assert.ok(merged.yaml.indexOf("host:") < merged.yaml.indexOf("nested:"));
    assert.ok(merged.yaml.indexOf("nullable:") < merged.yaml.indexOf("custom:"));
  });

  it("is idempotent after missing defaults have been added", () => {
    const first = mergeCpaConfigYaml(EXISTING, TEMPLATE);
    const second = mergeCpaConfigYaml(first.yaml, TEMPLATE);

    assert.deepEqual(second.addedPaths, []);
    assert.deepEqual(second.overwrittenPaths, []);
    assert.equal(second.yaml, first.yaml);
  });

  it("does not rewrite a freshly generated config just because the random template key differs", () => {
    const current = defaultConfigYaml("sk-current");
    const merged = mergeCpaConfigYaml(current, defaultConfigYaml("sk-next-random-value"));

    assert.deepEqual(merged.addedPaths, []);
    assert.deepEqual(merged.overwrittenPaths, []);
    assert.equal(merged.yaml, current);
  });

  it("replaces obsolete comments even when all semantic values already match", () => {
    const current = '# old comment\nhost: "127.0.0.1"\n';
    const template = '# new comment\nhost: "127.0.0.1"\n';
    const merged = mergeCpaConfigYaml(current, template);

    assert.deepEqual(merged.addedPaths, []);
    assert.deepEqual(merged.overwrittenPaths, []);
    assert.equal(merged.yaml, template);
  });

  it("preserves local settings and credentials while enforcing operational policy", () => {
    const template = `host: "127.0.0.1"
port: 8317
tls:
  enable: false
proxy-url: "template-proxy"
auth-dir: "auths"
api-keys:
  - template-key
claude-api-key:
  - api-key: template-provider-key
remote-management:
  allow-remote: false
  secret-key: "template-secret"
plugins:
  enabled: false
  configs:
    example:
      enabled: true
logging-to-file: true
logs-max-total-size-mb: 32
`;
    const existing = `host: "0.0.0.0"
port: 9000
tls:
  enable: true
  cert: local.pem
proxy-url: "direct"
auth-dir: "custom-auths"
api-keys:
  - local-key
claude-api-key:
  - api-key: local-provider-key
remote-management:
  allow-remote: true
  secret-key: "local-secret"
plugins:
  enabled: true
  configs:
    local-plugin:
      token: secret
logging-to-file: false
logs-max-total-size-mb: 999
custom-setting: retained
`;

    const merged = mergeCpaConfigYaml(existing, template);
    const config = YAML.parse(merged.yaml) as {
      host: unknown;
      port: unknown;
      tls: unknown;
      "proxy-url": unknown;
      "auth-dir": unknown;
      "api-keys": unknown;
      "claude-api-key": unknown;
      "remote-management": Record<string, unknown>;
      plugins: { enabled: unknown; configs: unknown };
      "logging-to-file": unknown;
      "logs-max-total-size-mb": unknown;
      "custom-setting": unknown;
    };

    assert.equal(config.host, "0.0.0.0");
    assert.equal(config.port, 9000);
    assert.deepEqual(config.tls, { enable: true, cert: "local.pem" });
    assert.equal(config["proxy-url"], "direct");
    assert.equal(config["auth-dir"], "custom-auths");
    assert.deepEqual(config["api-keys"], ["local-key"]);
    assert.deepEqual(config["claude-api-key"], [{ "api-key": "local-provider-key" }]);
    assert.equal(config["remote-management"]["allow-remote"], false);
    assert.equal(config["remote-management"]["secret-key"], "local-secret");
    assert.equal(config.plugins.enabled, false);
    assert.deepEqual(config.plugins.configs, { "local-plugin": { token: "secret" } });
    assert.equal(config["logging-to-file"], true);
    assert.equal(config["logs-max-total-size-mb"], 32);
    assert.equal(config["custom-setting"], "retained");
    assert.deepEqual(merged.overwrittenPaths, [
      "remote-management.allow-remote",
      "plugins.enabled",
      "logging-to-file",
      "logs-max-total-size-mb",
    ]);
  });

  it("rejects a non-mapping existing document", () => {
    assert.throws(
      () => mergeCpaConfigYaml("- one\n- two\n", TEMPLATE),
      /expected config\.yaml to contain a YAML mapping/i,
    );
  });
});

describe("syncCpaConfigDefaults", () => {
  it("backs up and atomically replaces an existing config", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-config-sync-"));
    temps.push(dir);
    const configPath = path.join(dir, "config.yaml");
    fs.writeFileSync(configPath, EXISTING);
    const now = new Date("2026-09-15T12:34:56.789Z");

    const result = syncCpaConfigDefaults(configPath, { templateYaml: TEMPLATE, now });

    const expectedBackup = `${configPath}.bak.2026-09-15T12-34-56-789Z`;
    assert.equal(result.changed, true);
    assert.equal(result.backupPath, expectedBackup);
    assert.deepEqual(result.addedPaths, ["nested.enabled"]);
    assert.deepEqual(result.overwrittenPaths, ["nested.count", "list", "nullable"]);
    assert.equal(fs.readFileSync(expectedBackup, "utf8"), EXISTING);
    assert.equal(fs.readFileSync(configPath, "utf8"), mergeCpaConfigYaml(EXISTING, TEMPLATE).yaml);
  });

  it("does not create a missing config or another backup once synchronized", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-config-sync-"));
    temps.push(dir);
    const missingPath = path.join(dir, "missing.yaml");
    assert.deepEqual(syncCpaConfigDefaults(missingPath, { templateYaml: TEMPLATE }), {
      changed: false,
      addedPaths: [],
      overwrittenPaths: [],
    });
    assert.equal(fs.existsSync(missingPath), false);

    const configPath = path.join(dir, "config.yaml");
    const synchronized = mergeCpaConfigYaml(EXISTING, TEMPLATE).yaml;
    fs.writeFileSync(configPath, synchronized);
    const result = syncCpaConfigDefaults(configPath, { templateYaml: TEMPLATE });
    assert.deepEqual(result, { changed: false, addedPaths: [], overwrittenPaths: [] });
    assert.deepEqual(fs.readdirSync(dir), ["config.yaml"]);
  });

  it("leaves invalid YAML untouched", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-config-sync-"));
    temps.push(dir);
    const configPath = path.join(dir, "config.yaml");
    const invalid = "host: [broken\n";
    fs.writeFileSync(configPath, invalid);

    assert.throws(
      () => syncCpaConfigDefaults(configPath, { templateYaml: TEMPLATE }),
      /Could not synchronize .*config\.yaml/,
    );
    assert.equal(fs.readFileSync(configPath, "utf8"), invalid);
    assert.deepEqual(fs.readdirSync(dir), ["config.yaml"]);
  });
});
