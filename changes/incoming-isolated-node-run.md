### Added

- **Incoming trust can start a signed Node entry through the macOS sandbox.** Kit checks the launch policy and read-only retained inputs under the current generation lock. The delegate checks its restrictions before loading the entry and stops the process at the signed time limit. On macOS, a separate host process ejects each temporary image when Kit exits abruptly.
