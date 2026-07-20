import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LEGACY_DEFAULT_API_KEY,
  normalizeCpaConfig,
  getListenAddress,
} from "./config-yaml.js";

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
