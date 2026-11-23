import assert from "node:assert/strict";
import { it } from "node:test";
import { hasCustomAuditRegistry, managerAuditEnv, verifiedConfig } from "./manager-audit-config.js";

it("permits ordinary settings that cannot hide npm registry findings", () => {
  assert.ok(
    verifiedConfig(".npmrc", "registry=https://registry.npmjs.org/\nnode-linker=isolated\n"),
  );
  assert.ok(
    verifiedConfig(
      ".yarnrc.yml",
      'nodeLinker: node-modules\nnpmRegistryServer: "https://registry.yarnpkg.com"\n',
    ),
  );
  assert.ok(verifiedConfig("pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n"));
  assert.ok(verifiedConfig("bunfig.toml", '[install]\nregistry="https://registry.npmjs.org"\n'));
});

it("refuses filter, custom-registry and executable project configuration", () => {
  for (const [file, settings] of [
    [".npmrc", "@team:registry=https://example.test/"],
    [".npmrc", "ignore-registry-errors=true"],
    [".yarnrc.yml", "npmAuditIgnoreAdvisories: [GHSA-2222-3333-4444]"],
    [".yarnrc.yml", "plugins:\n  - path: ./plugin.cjs"],
    [".yarnrc.yml", "yarnPath: ./local.cjs"],
    ["pnpm-workspace.yaml", "audit:\n  ignore: [GHSA-2222-3333-4444]"],
    [".pnpmfile.cjs", "module.exports = {};"],
    ["bunfig.toml", '[install.scopes]\n"@team"="https://example.test"'],
  ])
    assert.equal(verifiedConfig(file, settings), false, file);
});

it("clears inherited manager overrides that can alter output or request scope", () => {
  const env = managerAuditEnv({
    HOME: "/fixture",
    NODE_ENV: "production",
    NODE_OPTIONS: "--require fixture",
    YARN_NPM_AUDIT_EXCLUDE_PACKAGES: "example",
    COREPACK_ENABLE_NETWORK: "1",
    npm_config_ignore_registry_errors: "true",
  });
  assert.equal(env.HOME, "/fixture");
  assert.equal(env.NODE_ENV, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.YARN_NPM_AUDIT_EXCLUDE_PACKAGES, undefined);
  assert.equal(env.npm_config_ignore_registry_errors, undefined);
  assert.equal(env.COREPACK_ENABLE_NETWORK, "0");
});

it("refuses explicit private registry and alternate configuration before clearing overrides", () => {
  assert.equal(
    hasCustomAuditRegistry({ YARN_NPM_REGISTRY_SERVER: "https://private.example" }),
    true,
  );
  assert.equal(hasCustomAuditRegistry({ npm_config_userconfig: "/fixture/npmrc" }), true);
  assert.equal(
    hasCustomAuditRegistry({ NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/" }),
    false,
  );
});
