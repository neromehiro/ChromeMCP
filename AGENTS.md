# Development instructions

- Use Standard mode. Never enable Fast mode or a priority service tier.
- Do not spawn subagents.
- Keep existing browser operation behavior when packaging for standard MCP clients.
- Generated extension builds, executables, browser data and local configuration must remain ignored.
- Publish only the browser components listed in distribution-assets.json with provenance. Never include an enclosing project’s history or application executables.
- Run `python3 scripts/check_publication.py` before publishing.
- Verify the built wheel outside the source checkout; normal pip installation must work.
