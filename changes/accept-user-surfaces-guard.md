### Fixed

- The gates refuse `kit agent-audit --accept-user-surfaces` from an agent's shell tool. An agent could rewrite a user-level skill and accept the change itself, which silenced the drift warning. A person runs the acceptance in their own terminal.
