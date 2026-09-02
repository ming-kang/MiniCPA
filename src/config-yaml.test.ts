import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  LEGACY_DEFAULT_API_KEY,
  defaultConfigYaml,
  isTlsEnabled,
  normalizeCpaConfigWithWarnings,
  readCpaConfigWithWarnings,
} from "./config-yaml.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("normalizeCpaConfigWithWarnings", () => {
  it("warns when invalid port/host values are replaced by defaults", () => {
    const { config, warnings } = normalizeCpaConfigWithWarnings({
      host: 42,
      port: "8080x",
    });
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 8317);
    assert.equal(warnings.length, 2);
    assert.match(warnings.join("\n"), /invalid port "8080x"/);
    assert.match(warnings.join("\n"), /invalid host 42/);
  });

  it("does not warn for valid or absent values and applies defaults for non-objects", () => {
    assert.deepEqual(normalizeCpaConfigWithWarnings({ port: 9000 }).warnings, []);
    assert.deepEqual(normalizeCpaConfigWithWarnings({}).warnings, []);

    const nullResult = normalizeCpaConfigWithWarnings(null);
    assert.equal(nullResult.config.host, "127.0.0.1");
    assert.equal(nullResult.config.port, 8317);
    assert.deepEqual(nullResult.warnings, []);

    const nonObjectResult = normalizeCpaConfigWithWarnings("nope");
    assert.equal(nonObjectResult.config.host, "127.0.0.1");
    assert.equal(nonObjectResult.config.port, 8317);
    assert.deepEqual(nonObjectResult.warnings, []);
  });

  it("warns on out-of-range ports", () => {
    const { config, warnings } = normalizeCpaConfigWithWarnings({ port: 0 });
    assert.equal(config.port, 8317);
    assert.equal(warnings.length, 1);

    const highPort = normalizeCpaConfigWithWarnings({ port: 99999 });
    assert.equal(highPort.config.port, 8317);
    assert.equal(highPort.warnings.length, 1);
  });

  it("coerces and sanitizes host, port, api-keys", () => {
    const { config } = normalizeCpaConfigWithWarnings({
      host: " 0.0.0.0 ",
      port: "9000",
      "api-keys": [LEGACY_DEFAULT_API_KEY, 123, null, "ok"],
    });
    assert.equal(config.host, "0.0.0.0");
    assert.equal(config.port, 9000);
    assert.deepEqual(config["api-keys"], [LEGACY_DEFAULT_API_KEY, "ok"]);

    const singleKeyResult = normalizeCpaConfigWithWarnings({
      "api-keys": "single-secret-key",
    });
    assert.deepEqual(singleKeyResult.config["api-keys"], ["single-secret-key"]);
  });

  it("warns when TLS fields have unsafe shapes", () => {
    const sectionWarning = normalizeCpaConfigWithWarnings({ tls: true }).warnings;
    assert.equal(sectionWarning.length, 1);
    assert.match(sectionWarning[0] ?? "", /invalid tls true.*expected an object/);

    const { config: invalidFieldCfg, warnings: fieldWarnings } = normalizeCpaConfigWithWarnings({
      tls: { enable: "true", cert: 123, key: null },
    });
    assert.equal(fieldWarnings.length, 2);
    assert.match(fieldWarnings.join("\n"), /invalid tls\.enable "true".*true or false/);
    assert.match(fieldWarnings.join("\n"), /invalid tls\.cert 123.*expected a string/);
    assert.deepEqual(invalidFieldCfg.tls, {});
    assert.equal(isTlsEnabled(invalidFieldCfg), false);
  });
});

describe("readCpaConfigWithWarnings", () => {
  it("generates an explicit TLS-disabled starter config", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-config-yaml-"));
    temps.push(dir);
    const configPath = path.join(dir, "config.yaml");
    const generated = defaultConfigYaml("sk-test");
    assert.match(generated, /tls:\n {2}enable: false\n {2}cert: ""\n {2}key: ""/);
    assert.match(generated, /disable-auto-update-panel: false/);
    fs.writeFileSync(configPath, generated);

    const { config, warnings } = readCpaConfigWithWarnings(configPath);
    assert.deepEqual(warnings, []);
    assert.equal(isTlsEnabled(config), false);
    assert.equal(config.tls?.cert, "");
    assert.equal(config.tls?.key, "");
    assert.equal(config["remote-management"]?.["disable-control-panel"], false);
    assert.equal(config["remote-management"]?.["disable-auto-update-panel"], false);
  });

  it("reads and parses tls config from config.yaml", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-config-yaml-"));
    temps.push(dir);
    const configPath = path.join(dir, "config.yaml");
    fs.writeFileSync(
      configPath,
      "host: '127.0.0.1'\nport: 8317\ntls:\n  enable: true\n  cert: 'c.pem'\n  key: 'k.pem'\n",
    );

    const { config, warnings } = readCpaConfigWithWarnings(configPath);
    assert.deepEqual(warnings, []);
    assert.equal(config.tls?.enable, true);
    assert.equal(config.tls?.cert, "c.pem");
    assert.equal(config.tls?.key, "k.pem");
    assert.equal(isTlsEnabled(config), true);
  });

  it("reads CLIProxyAPI-owned Web panel settings for diagnostics", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-config-yaml-"));
    temps.push(dir);
    const configPath = path.join(dir, "config.yaml");
    fs.writeFileSync(
      configPath,
      "remote-management:\n  disable-control-panel: true\n  disable-auto-update-panel: true\n  panel-github-repository: https://github.com/example/panel\n",
    );

    const { config } = readCpaConfigWithWarnings(configPath);
    assert.equal(config["remote-management"]?.["disable-control-panel"], true);
    assert.equal(config["remote-management"]?.["disable-auto-update-panel"], true);
    assert.equal(
      config["remote-management"]?.["panel-github-repository"],
      "https://github.com/example/panel",
    );
  });

  it("names the offending file when the YAML cannot be parsed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minicpa-config-yaml-"));
    temps.push(dir);
    const configPath = path.join(dir, "config.yaml");
    fs.writeFileSync(configPath, "host: '127.0.0.1\nport: [8317\n");

    assert.throws(
      () => readCpaConfigWithWarnings(configPath),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /^Invalid YAML in /);
        assert.ok(err.message.includes(configPath));
        return true;
      },
    );
  });
});
