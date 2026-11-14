### Fixed

- **`kit usage` no longer cuts a control's name mid-word.** The Proof tab cut each control's name at
  44 columns in a 66-column box, so `env-write gate refuses a plaintext credential in .env` read as
  `…plaintext credentia`, with nothing to say text was missing. Names now use the box's width, and
  any cut ends in `…`.
