### Fixed

- **Diagnostic text shows a line break as one space instead of joining the words around it.**
  `sanitizeDisplayText` removed CR and LF with the other control characters, so
  `found on\nhttps://h.example` was shown as `found onhttps://h.example`. A CR, LF or CRLF run
  now becomes a single space, and a space already beside it is not doubled. Every other control
  character, bidi mark and terminal sequence is still removed as before, and a credential that a
  line break splits is still joined and masked.
