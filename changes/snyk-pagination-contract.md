### Fixed

- **Snyk issue pagination follows the published link format.** Kit accepts both string links and JSON:API link objects. It retains readable findings and refuses links that change the requested issue scope. An empty result requires a valid JSON:API response.
