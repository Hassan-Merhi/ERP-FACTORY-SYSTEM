# Secure deepmerge adapter

The Puppeteer Extra plugin stack requires the `deepmerge` v4 API, but upstream
`deepmerge@4.3.1` has no patched release for GHSA-gcqx-w48m-w2h4.

This local MIT-licensed, API-compatible implementation is used **only** through
the root `package.json` override of the transitive `deepmerge` dependency.
It explicitly rejects `__proto__`, `constructor`, and `prototype` keys
from both inputs and nested objects and defines safe own properties.

Do not silently replace it with unpatched upstream `deepmerge@4.3.1`.
The source is derived from https://github.com/TehShrike/deepmerge/tree/v4.3.1.
Run the secure-adapter tests and the existing scraper tests after any change.
