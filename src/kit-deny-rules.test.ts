/**
 * kit's deny rules read back from a settings file, and the allow rules that would undo one
 * (kit-research prismor-always-allowed-rules-vs-kit, Measurement §2).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { KIT_DENY_RULES } from "./agent-config-strict.js";
import {
  KIT_REFUSING_DENY_RULES,
  allowMatchesDeny,
  allowsOverridingKitDeny,
  heldKitDenyRules,
  missingKitDenyRules,
  permissionListsOf,
} from "./kit-deny-rules.js";

const HOME = "/home/dev";

describe("kit deny rules in a settings file", () => {
  it("reads permissions and names the kit rules missing from deny", () => {
    const deny = KIT_DENY_RULES.filter((r) => !r.includes("~/.ssh") && !r.includes("git push"));
    const text = JSON.stringify({ permissions: { allow: ["Bash(ls)"], deny } });
    const lists = permissionListsOf(text);
    assert.deepEqual(lists?.allow, ["Bash(ls)"]);
    assert.deepEqual(missingKitDenyRules(lists?.deny ?? []), [
      "Read(~/.ssh/**)",
      "Bash(git push *--force*)",
      "Bash(git push -f*)",
      "Bash(git push * -f*)",
      "Bash(git push * +*)",
    ]);
    assert.equal(heldKitDenyRules(deny).length, KIT_DENY_RULES.length - 5);
  });

  it("returns null for text that is not a JSON object, and empty lists without permissions", () => {
    assert.equal(permissionListsOf("{"), null);
    assert.equal(permissionListsOf("[]"), null);
    assert.deepEqual(permissionListsOf("{}"), { allow: [], deny: [] });
  });
});

describe("allow rules that match a kit deny rule", () => {
  it("every refusing kit deny rule has a witness its own rule matches", () => {
    assert.equal(KIT_REFUSING_DENY_RULES.length, KIT_DENY_RULES.length - 1);
    for (const deny of KIT_REFUSING_DENY_RULES) {
      assert.ok(allowMatchesDeny(deny, deny, HOME), deny);
    }
  });

  it("matches the measured allows: Read(~/.ssh/**) and Bash(git push:*)", () => {
    const found = allowsOverridingKitDeny(
      ["Bash(curl https://api.internal.example.com/*)", "Read(~/.ssh/**)", "Bash(git push:*)"],
      HOME,
    );
    assert.deepEqual(found.map((o) => o.allow).sort(), [
      "Bash(git push:*)",
      "Bash(git push:*)",
      "Bash(git push:*)",
      "Bash(git push:*)",
      "Read(~/.ssh/**)",
    ]);
  });

  it("matches broad forms: a bare tool, *, ~/**, an absolute // path and a name at any depth", () => {
    assert.ok(allowMatchesDeny("Bash", "Bash(git reset *--hard*)", HOME));
    assert.ok(allowMatchesDeny("Bash(*)", "Bash(git push -f*)", HOME));
    assert.ok(allowMatchesDeny("Bash(git *)", "Bash(git push * +*)", HOME));
    assert.ok(allowMatchesDeny("Read", "Read(~/.aws/**)", HOME));
    assert.ok(allowMatchesDeny("Read(~/**)", "Read(~/.gnupg/**)", HOME));
    assert.ok(allowMatchesDeny("Read(//home/dev/.ssh/*)", "Read(~/.ssh/**)", HOME));
    assert.ok(allowMatchesDeny("Read(.env*)", "Read(.env.*)", HOME));
    assert.ok(allowMatchesDeny("Read(**/.env)", "Read(.env)", HOME));
  });

  it("does not match a narrower rule, another tool, or the .env.example carve-out", () => {
    assert.equal(allowMatchesDeny("Bash(git push origin main)", "Bash(git push -f*)", HOME), false);
    assert.equal(allowMatchesDeny("Bash(git status:*)", "Bash(git reset *--hard*)", HOME), false);
    assert.equal(allowMatchesDeny("Edit(~/.ssh/**)", "Read(~/.ssh/**)", HOME), false);
    assert.equal(allowMatchesDeny("Read(~/.sshx/**)", "Read(~/.ssh/**)", HOME), false);
    assert.equal(allowMatchesDeny("Read(/.ssh/**)", "Read(~/.ssh/**)", HOME), false);
    assert.equal(allowMatchesDeny("Read(.env.example)", "Read(.env.*)", HOME), false);
    assert.deepEqual(allowsOverridingKitDeny(["Read(!.env.example)", "Read(src/**)"], HOME), []);
  });
});
