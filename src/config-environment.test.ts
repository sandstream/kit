import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveActiveEnvironment } from "./config.js";

describe("resolveActiveEnvironment", () => {
  it("returns dev by default", () => {
    const env = resolveActiveEnvironment([]);
    assert.equal(env, "dev");
  });

  it("reads --env= flag from args", () => {
    assert.equal(resolveActiveEnvironment(["--env=staging"]), "staging");
    assert.equal(resolveActiveEnvironment(["check", "--env=production"]), "production");
  });

  it("reads KIT_ENV env var", () => {
    const orig = process.env.KIT_ENV;
    process.env.KIT_ENV = "staging";
    try {
      assert.equal(resolveActiveEnvironment([]), "staging");
    } finally {
      if (orig === undefined) delete process.env.KIT_ENV;
      else process.env.KIT_ENV = orig;
    }
  });

  it("maps NODE_ENV=production → prod", () => {
    const origkitEnv = process.env.KIT_ENV;
    const origNodeEnv = process.env.NODE_ENV;
    delete process.env.KIT_ENV;
    process.env.NODE_ENV = "production";
    try {
      assert.equal(resolveActiveEnvironment([]), "prod");
    } finally {
      if (origkitEnv === undefined) delete process.env.KIT_ENV;
      else process.env.KIT_ENV = origkitEnv;
      if (origNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = origNodeEnv;
    }
  });

  it("maps NODE_ENV=development → dev", () => {
    const origkitEnv = process.env.KIT_ENV;
    const origNodeEnv = process.env.NODE_ENV;
    delete process.env.KIT_ENV;
    process.env.NODE_ENV = "development";
    try {
      assert.equal(resolveActiveEnvironment([]), "dev");
    } finally {
      if (origkitEnv === undefined) delete process.env.KIT_ENV;
      else process.env.KIT_ENV = origkitEnv;
      if (origNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = origNodeEnv;
    }
  });

  it("--env= flag takes precedence over KIT_ENV", () => {
    const orig = process.env.KIT_ENV;
    process.env.KIT_ENV = "staging";
    try {
      assert.equal(resolveActiveEnvironment(["--env=production"]), "production");
    } finally {
      if (orig === undefined) delete process.env.KIT_ENV;
      else process.env.KIT_ENV = orig;
    }
  });
});
