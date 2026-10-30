# Development instructions

- Use Standard mode. Never enable Fast mode or a priority service tier.
- Do not spawn subagents.
- Keep browser behavior in the pinned upstream runtime. Do not invent replacement behavior.
- External runtime files, generated extension builds, browser data, and local configuration must remain ignored.
- Never commit third-party runtime bundles or an enclosing project’s Git history.
- Run `python3 scripts/check_publication.py` before publishing.
- Install from a source checkout with `pip install -e .`; the runtime uses files adjacent to the Python package.
