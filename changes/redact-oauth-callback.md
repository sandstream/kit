### Fixed

- Redaction now covers an OAuth callback URL's authorization `code` (when the query also carries `state`) and a PKCE `code_verifier`. A pasted `http://localhost:<port>/callback?code=…&state=…` passed through unredacted.
