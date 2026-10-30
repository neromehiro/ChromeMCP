# Component provenance

ChromeMCP includes local Python MCP/transport adapters and extension connection UI.
The browser engine, extension backend, accessibility WASM, content scripts and image assets originate from desktop browser components version 1.26.901.11451.

- `upstream/browser-engine.mjs`: preserved browser service implementation with appended exports.
- `upstream/extension-core.js`: extension backend with local transport entry points; original app bootstrap omitted.
- `upstream/browser-accessibility.wasm.br`, `content-scripts/*`, `images/*`: original components.
- `upstream/local-host.mjs`, `upstream/engine-worker.mjs`: local host and command adapters.

`vendor-lock.json` records hashes from the original bridge snapshot; `distribution-assets.json` defines the packaged files.
These components are not presented as independently authored ChromeMCP code or relicensed under MIT.
No blanket open-source license is assigned by this repository. Original third-party rights and applicable terms remain with their owners.
ChromeMCP is not an official OpenAI or Google product.

Node.js, Python, `mcp` and `websockets` are separately installed dependencies with their own licenses.
Desktop application executables, Node REPL executables, account data and private parent-project source are not included or needed by the standard MCP entry point.

The standalone adapter enables its declared browser-management API locally rather than consulting the desktop app feature-flag service. Original origin-consent and policy evaluation remain active, with permission requests forwarded to the MCP client.
