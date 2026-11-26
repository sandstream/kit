### Added

- **`kit check` reads Firebase security rules.** A new `firebase security rules` row reads
  `firestore.rules`, `storage.rules` and the rules files `firebase.json` names. It fails on an
  `allow` with `if true` or with no condition, critical when it opens writes, and warns on
  `if request.auth != null` over a wildcard match (`/{document=**}`, `/{coll}/{doc}`), where any
  signed-in user reads every document. Comments, multi-line statements, nested `match` blocks and
  `function` bodies are handled; conditions are compared as text, so a function that returns
  `true` is not resolved. It skips with a reason when the project has no rules file. Before this,
  kit did not read Firebase rules at all (sandstream/kit-research#230).
