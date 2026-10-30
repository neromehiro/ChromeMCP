import argparse
import asyncio
import json
import logging
import os
from pathlib import Path
import sys

from .client import browser_call, request
from .captures import save_capture
from .daemon import run_daemon
from .protocol import DEFAULT_PORT, BridgeError


async def command(args):
    if args.command == "serve":
        await run_daemon(args.port)
        return
    if args.command == "status":
        result = await request("status", port=args.port)
    elif args.command == "tabs":
        result = await browser_call("tabs_list", browser_id=args.browser, port=args.port)
    elif args.command == "sessions":
        result = await browser_call("session_list", browser_id=args.browser, port=args.port)
    elif args.command == "search":
        params = {"query": args.query}
        if args.tab is not None:
            params["tab_id"] = args.tab
        result = await browser_call("google_search", params, args.browser, args.port)
    elif args.command == "snapshot":
        result = await browser_call("page_snapshot", {"tab_id": args.tab}, args.browser, args.port)
    elif args.command == "screenshot":
        result = await browser_call("screenshot", {"tab_id": args.tab}, args.browser, args.port)
        encoded = result["data_url"].split(",", 1)[1]
        result = save_capture(encoded, args.tab, str(args.output.resolve()) if args.output else None)
    print(json.dumps(result, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description="ChromeMCP local Chrome extension bridge")
    parser.add_argument("--port", type=int, default=int(os.environ.get("CHROME_BRIDGE_PORT", DEFAULT_PORT)))
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("serve", help="Start the local loopback WebSocket bridge")
    for name in ("mcp", "mcp-native", "mcp-upstream"):
        child = sub.add_parser(name, help="Original Node REPL MCP with a selectable host config source")
        child.add_argument("--config-source", choices=("codex", "local"), default="codex")
        child.add_argument("--policy-file", type=Path, help="Local host policy JSON (with --config-source local)")
    sub.add_parser("mcp-compat", help="Legacy Python browser_* tools for compatibility")
    sub.add_parser("status", help="List connected Chrome profiles")
    for name in ["tabs", "sessions", "search", "snapshot", "screenshot"]:
        child = sub.add_parser(name)
        child.add_argument("--browser", help="Connected browser/profile ID")
        if name == "search":
            child.add_argument("query", nargs="?", default="こんにちは")
            child.add_argument("--tab", type=int)
        if name in {"snapshot", "screenshot"}:
            child.add_argument("tab", type=int)
        if name == "screenshot":
            child.add_argument("--output", type=Path, help="Absolute or relative output path with the actual image extension; omitted uses the cache")
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("port must be between 1024 and 65535")
    if args.command in {'mcp','mcp-native','mcp-upstream'}:
        from .native_mcp import run
        if args.policy_file and args.config_source != 'local':
            parser.error('--policy-file requires --config-source local')
        run(args.port, config_source=args.config_source, policy_file=args.policy_file)
        return
    if args.command == "mcp-compat":
        from .mcp_server import run
        os.environ["CHROME_BRIDGE_PORT"] = str(args.port)
        run()
        return
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        asyncio.run(command(args))
    except KeyboardInterrupt:
        pass
    except (BridgeError, OSError) as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
