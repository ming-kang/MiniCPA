import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LEGACY_DEFAULT_API_KEY,
  normalizeCpaConfig,
  normalizeCpaConfigWithWarnings,
  getListenAddress,
} from "./config-yaml.js";

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
});
