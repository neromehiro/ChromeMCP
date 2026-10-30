import asyncio
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from chrome_bridge.distribution import export_extension, EXTENSION_FILES
from chrome_bridge.protocol import ROOT
from chrome_bridge.standalone import validate_installation


class StandaloneTests(unittest.IsolatedAsyncioTestCase):
    async def test_mcp_starts_loopback_without_external_application_or_extension(self):
        validate_installation()
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0))
            port = probe.getsockname()[1]
        with tempfile.TemporaryDirectory() as temp:
            env = dict(os.environ)
            env['PYTHONPATH'] = str(Path(__file__).resolve().parents[1])
            params = StdioServerParameters(command=sys.executable, args=['-m', 'chrome_bridge.cli', '--port', str(port), 'mcp'], cwd=temp, env=env)
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write) as client:
                    result = await client.initialize()
                    self.assertEqual(result.serverInfo.name, 'ChromeMCP')
                    tools = await client.list_tools()
                    self.assertIn('browser_open', {tool.name for tool in tools.tools})
                    status = await client.call_tool('browser_list', {})
                    self.assertFalse(status.isError)
                    self.assertEqual(json.loads(status.content[0].text)['browsers'], [])
                    result = await client.call_tool('browser_open', {'url': 'https://example.test/'})
                    self.assertTrue(result.isError)
            # Lifespan teardown releases the listening socket.
            with self.assertRaises(OSError):
                await asyncio.open_connection('127.0.0.1', port)

    def test_extension_export_is_complete_and_does_not_overwrite(self):
        with tempfile.TemporaryDirectory() as temp:
            dest = Path(temp) / 'ChromeMCP'
            export_extension(dest)
            for name in EXTENSION_FILES:
                self.assertEqual((dest / name).read_bytes(), (ROOT / name).read_bytes())
            with self.assertRaises(ValueError):
                export_extension(dest)
