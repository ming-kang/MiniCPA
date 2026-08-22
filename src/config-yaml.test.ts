import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  LEGACY_DEFAULT_API_KEY,
  defaultConfigYaml,
  getListenAddress,
  isTlsEnabled,
  normalizeCpaConfig,
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

  it("does not warn for valid or absent values", () => {
    assert.deepEqual(normalizeCpaConfigWithWarnings({ port: 9000 }).warnings, []);
    assert.deepEqual(normalizeCpaConfigWithWarnings({}).warnings, []);
    assert.deepEqual(normalizeCpaConfigWithWarnings(null).warnings, []);
  });

  it("warns on out-of-range ports", () => {
    const { config, warnings } = normalizeCpaConfigWithWarnings({ port: 0 });
    assert.equal(config.port, 8317);
    assert.equal(warnings.length, 1);
  });

  it("warns when TLS fields have unsafe shapes", () => {
    const sectionWarning = normalizeCpaConfigWithWarnings({ tls: true }).warnings;
    assert.equal(sectionWarning.length, 1);
    assert.match(sectionWarning[0] ?? "", /invalid tls true.*expected an object/);

    const fieldWarnings = normalizeCpaConfigWithWarnings({
      tls: { enable: "true", cert: 123, key: null },
    }).warnings;
    assert.equal(fieldWarnings.length, 2);
    assert.match(fieldWarnings.join("\n"), /invalid tls\.enable "true".*true or false/);
    assert.match(fieldWarnings.join("\n"), /invalid tls\.cert 123.*expected a string/);
  });
});

describe("normalizeCpaConfig", () => {
  it("applies defaults for empty/invalid docs", () => {
    assert.deepEqual(getListenAddress(normalizeCpaConfig(null)), {
      host: "127.0.0.1",
      port: 8317,
    });
    assert.deepEqual(getListenAddress(normalizeCpaConfig("nope")), {
      host: "127.0.0.1",
      port: 8317,
    });
  });

  it("coerces host/port/api-keys", () => {
    const cfg = normalizeCpaConfig({
      host: " 0.0.0.0 ",
      port: "9000",
      "api-keys": "single-key",
    });
    assert.equal(cfg.host, "0.0.0.0");
    assert.equal(cfg.port, 9000);
    assert.deepEqual(cfg["api-keys"], ["single-key"]);
  });

  it("drops non-string api-keys entries", () => {
    const cfg = normalizeCpaConfig({
      "api-keys": [LEGACY_DEFAULT_API_KEY, 123, null, "ok"],
    });
    assert.deepEqual(cfg["api-keys"], [LEGACY_DEFAULT_API_KEY, "ok"]);
  });

  it("rejects out-of-range ports", () => {
    assert.equal(normalizeCpaConfig({ port: 0 }).port, 8317);
    assert.equal(normalizeCpaConfig({ port: 99999 }).port, 8317);
  });

  it("parses tls configuration and handles non-object tls safely", () => {
    const enabledCfg = normalizeCpaConfig({
      tls: {
        enable: true,
        cert: "certs/server.crt",
        key: "certs/server.key",
      },
    });
    assert.deepEqual(enabledCfg.tls, {
      enable: true,
      cert: "certs/server.crt",
      key: "certs/server.key",
    });
    assert.equal(isTlsEnabled(enabledCfg), true);

    const disabledCfg = normalizeCpaConfig({
      tls: {
        enable: false,
      },
    });
    assert.equal(disabledCfg.tls?.enable, false);
    assert.equal(isTlsEnabled(disabledCfg), false);

    const nonObjectCfg = normalizeCpaConfig({ tls: "invalid" });
    assert.equal(nonObjectCfg.tls, undefined);
    assert.equal(isTlsEnabled(nonObjectCfg), false);

    const invalidFieldCfg = normalizeCpaConfig({
      tls: {
        enable: "true",
        cert: 123,
        key: null,
      },
    });
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
    fs.writeFileSync(configPath, generated);

    const { config, warnings } = readCpaConfigWithWarnings(configPath);
    assert.deepEqual(warnings, []);
    assert.equal(isTlsEnabled(config), false);
    assert.equal(config.tls?.cert, "");
    assert.equal(config.tls?.key, "");
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
