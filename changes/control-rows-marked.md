### Fixed

- `kit check` and `kit usage prove` run two negative controls that make a gate refuse, and each refusal was written to the project's audit log with nothing to tell it from an agent's: every `kit check` added a row saying a plaintext Stripe key was written to `.env`. The control rows now carry `metadata.session_id: "kit-negative-control"`.
