# External runtime boundary

ChromeMCP contains the local transport, host adapters, extension connection UI, build scripts, and tests.
It relies on runtime components originally supplied with an external desktop application.
The tested browser component version is 1.26.901.11451.

The following are intentionally absent from Git:

- Original or transformed browser service, browser client, extension backend, accessibility WASM
- Original content scripts and cursor/icon assets
- Node REPL executable, Node executable, and bundled dependencies
- Generated unpacked extension and original source snapshots

`vendor-lock.json` contains hashes, not the external components themselves.
`scripts/import_runtime.py` imports a fixed list from an existing local installation prepared for this bridge.
It does not download external components or grant redistribution rights.
`build_upstream.py` records the pinned transformations for developers with the corresponding local source snapshot;
it is not a downloader or a general extractor for arbitrary application versions.

Python dependencies (`mcp`, `websockets`) are installed separately under their respective licenses.
Project-specific source is publicly visible, but no blanket open-source license has yet been assigned.
