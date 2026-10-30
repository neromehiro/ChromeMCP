"""Exercise an installed wheel via real stdio MCP and an isolated test Chrome profile.

Required: CHROME_EXECUTABLE_PATH, CHROME_MCP_COMMAND, CHROME_BRIDGE_NODE.
No source imports, remote-debugging port, user profile, login, or model calls.
"""
import asyncio
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from mcp import ClientSession, StdioServerParameters, types
from mcp.client.stdio import stdio_client


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()
        self.wfile.write(b'<title>ChromeMCP local test</title><label>Query<input id="query"></label><button id="load" onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#query\').value+\':trusted=\'+event.isTrusted">Load</button><p id="result">before</p>')


async def main():
    command = os.environ['CHROME_MCP_COMMAND']
    chrome = os.environ['CHROME_EXECUTABLE_PATH']
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    web = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    threading.Thread(target=web.serve_forever, daemon=True).start()
    process = None
    with tempfile.TemporaryDirectory(prefix='chromemcp-wheel-smoke-') as temporary:
        root = Path(temporary)
        ext = root / 'extension'
        subprocess.run([command, 'extension', str(ext)], cwd=root, check=True)
        background = ext / 'background.js'
        background.write_text(background.read_text().replace('|| 8768', f'|| {port}'))
        env = dict(os.environ)
        env['CHROME_MCP_POLICY_PATH'] = str(root / 'policy.json')
        (root / 'policy.json').write_text(json.dumps({'global': {'approval_mode': 'never_ask'}, 'requirements': {'network': {'domains': {'blocked.invalid': 'deny'}}}}))
        params = StdioServerParameters(command=command, args=['--port', str(port), 'mcp'], cwd=str(root), env=env)
        try:
            async with stdio_client(params) as (read, write):
                async def consent(context, params):
                    # The test runner must receive explicit human authorization.
                    # Never enable this in production or approve another origin.
                    metadata = params.model_dump(by_alias=True).get('_meta') or {}
                    origin = metadata.get('origin') if isinstance(metadata, dict) else None
                    if os.environ.get('CHROME_MCP_TEST_APPROVAL') == 'local-fixture' and origin == f'http://127.0.0.1:{web.server_port}':
                        return types.ElicitResult(action='accept', content={})
                    return types.ElicitResult(action='decline')
                async with ClientSession(read, write, elicitation_callback=consent) as client:
                    initialized = await client.initialize()
                    assert initialized.serverInfo.name == 'ChromeMCP'
                    tools = await client.list_tools()
                    assert {'browser_list', 'browser_open', 'browser_fill'} <= {tool.name for tool in tools.tools}
                    async def call(name, arguments=None, error=False):
                        result = await client.call_tool(name, arguments or {})
                        if error:
                            assert result.isError, result
                            return result
                        assert not result.isError, result
                        if result.structuredContent is not None:
                            value = result.structuredContent
                            return value['result'] if set(value) == {'result'} else value
                        texts = [json.loads(item.text) for item in result.content if item.type == 'text']
                        if name == 'browser_tabs':
                            return texts[0] if len(texts) == 1 and isinstance(texts[0], list) else texts
                        return texts[0]
                    assert (await call('browser_list'))['browsers'] == []
                    await call('browser_open', {'url': 'https://example.com'}, error=True)
                    # Explicit isolated Profile 20 selected from Python. No user's profile data is read.
                    with (root / 'chrome.log').open('w') as log:
                        process = subprocess.Popen([chrome, '--headless=new', '--profile-directory=Profile 20', '--user-data-dir='+str(root/'profile'), '--no-first-run', '--disable-extensions-except='+str(ext), '--load-extension='+str(ext), 'about:blank'], stdout=log, stderr=log)
                    for _ in range(100):
                        status = await call('browser_list')
                        if status['browsers']:
                            break
                        await asyncio.sleep(.2)
                    assert status['browsers'], 'Test extension did not connect'
                    browser = status['browsers'][0]['id']
                    await call('browser_name_session', {'name': 'ChromeMCP test', 'browser_id': browser})
                    opened = await call('browser_open', {'url': f'http://127.0.0.1:{web.server_port}/', 'browser_id': browser})
                    tab = int(opened['id'])
                    snapshot = await call('browser_snapshot', {'tab_id': tab, 'browser_id': browser})
                    assert 'Query' in json.dumps(snapshot)
                    await call('browser_fill', {'tab_id': tab, 'selector': '#query', 'value': 'hello MCP', 'browser_id': browser})
                    await call('browser_click', {'tab_id': tab, 'selector': '#load', 'browser_id': browser})
                    snapshot = await call('browser_snapshot', {'tab_id': tab, 'browser_id': browser})
                    assert 'hello MCP:trusted=true' in json.dumps(snapshot), snapshot
                    capture = await call('browser_screenshot', {'tab_id': tab, 'browser_id': browser, 'save_path': str(root/'capture.jpg')})
                    assert Path(capture['path']).is_file()
                    await call('browser_navigate', {'tab_id': tab, 'url': 'http://blocked.invalid/', 'browser_id': browser}, error=True)
                    await call('browser_end_turn', {'browser_id': browser})
                    tabs = await call('browser_tabs', {'browser_id': browser})
                    assert isinstance(tabs, list), tabs
                    assert tab not in [int(t['id']) for t in tabs]
                    print(json.dumps({'passed': True, 'tool_count': len(tools.tools), 'checks': ['installed wheel only', 'MCP autostart', 'extension export', 'no-browser error', 'real Chrome connection', 'navigation + snapshot', 'fill + trusted click', 'screenshot', 'policy denial', 'tab cleanup']}, indent=2))
        finally:
            web.shutdown()
            if process:
                process.terminate()
                try:
                    process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


if __name__ == '__main__':
    asyncio.run(main())
