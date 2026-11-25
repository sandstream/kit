### Changed

- **ADR-0010 is accepted: a gate may ask a person, only through the agent harness, and an ask no person can answer is a deny.** Accepting it changes no gate today; every command class is still allow or deny. The `ask` outcome, the tests that hold it (ask is deny without a channel; project config cannot loosen deny to ask) and each class that moves to `ask` come in their own pull requests, each with its measurement.
