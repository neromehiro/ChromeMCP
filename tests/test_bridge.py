import asyncio
import json
import os
from pathlib import Path
import sys
import unittest
import uuid
from unittest.mock import AsyncMock

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus

from chrome_bridge.client import browser_call, request
from chrome_bridge.daemon import Bridge
from chrome_bridge.protocol import BridgeError


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.bridge = Bridge(0)
        self.server = await self.bridge.serve()
        self.port = self.server.sockets[0].getsockname()[1]
        self.bridge.port = self.port
        self.sockets = []

    async def asyncTearDown(self):
        await self.bridge.engine.close()
        for socket in self.sockets:
            await socket.close()
        self.server.close()
        await self.server.wait_closed()

    async def add_browser(self, label="Test Chrome", version="unknown"):
        socket = await connect(f"ws://127.0.0.1:{self.port}/extension", origin=self.bridge.origin)
        self.sockets.append(socket)
        instance = str(uuid.uuid4())
        await socket.send(json.dumps({"type": "hello", "protocol": 1, "instance_id": instance, "label": label,"version":version}))
        self.assertEqual(json.loads(await socket.recv())["type"], "welcome")
        return socket, instance

    async def test_unicode_command_roundtrip(self):
        socket, instance = await self.add_browser()
        task = asyncio.create_task(browser_call("google_search", {"query": "こんにちは"}, port=self.port))
        command = json.loads(await socket.recv())
        self.assertEqual(command["action"], "google_search")
        self.assertEqual(command["params"]["query"], "こんにちは")
        await socket.send(json.dumps({"type": "response", "id": command["id"], "result": {"title": "こんにちは - Google 検索"}}))
        self.assertEqual(await task, {"title": "こんにちは - Google 検索"})
        self.assertFalse(self.bridge.pending)
        status = await request("status", port=self.port)
        self.assertEqual(status["browsers"][0]["id"], instance)

    async def test_bodyless_notification_and_native_shutdown_preserve_contract(self):
        socket, instance = await self.add_browser(version='0.5.1')
        endpoint = self.bridge.browsers[instance].native_endpoint
        reader, writer = await asyncio.open_unix_connection(str(endpoint.path))
        async def receive():
            size = int.from_bytes(await reader.readexactly(4), sys.byteorder)
            return json.loads(await reader.readexactly(size))
        try:
            body = json.dumps({'jsonrpc':'2.0','id':1,'method':'ping','params':{}}).encode()
            writer.write(len(body).to_bytes(4,sys.byteorder)+body)
            await writer.drain()
            command = json.loads(await socket.recv())
            await socket.send(json.dumps({'type':'response','id':command['id'],'result':'pong'}))
            self.assertEqual((await receive())['result'],'pong')
            await socket.send(json.dumps({'type':'upstream_event','name':'onBrowserTabMentionsInvalidated'}))
            self.assertEqual(await receive(),{'jsonrpc':'2.0','method':'onBrowserTabMentionsInvalidated'})
            await socket.send(json.dumps({'type':'upstream_event','name':'explicit-null','value':None}))
            self.assertEqual(await receive(),{'jsonrpc':'2.0','method':'explicit-null','params':None})
            await socket.send('{"type":"heartbeat"}')
            self.assertEqual(json.loads(await socket.recv())['type'],'heartbeat_ack')
            # A reconnect closes existing native clients before waiting for the server.
            await asyncio.wait_for(endpoint.close(),2)
            self.assertEqual(await asyncio.wait_for(reader.read(),2),b'')
        finally:
            writer.close()
            await writer.wait_closed()

    async def test_native_rpc_error_keeps_original_code_and_data(self):
        socket, instance = await self.add_browser(version='0.5.1')
        reader, writer = await asyncio.open_unix_connection(str(self.bridge.browsers[instance].native_endpoint.path))
        try:
            body=json.dumps({'jsonrpc':'2.0','id':1,'method':'unknown-method','params':{}}).encode()
            writer.write(len(body).to_bytes(4,sys.byteorder)+body);await writer.drain()
            command=json.loads(await socket.recv())
            error={'code':-1,'message':'No handler registered for method: unknown-method','data':{'reason':'unsupported'}}
            await socket.send(json.dumps({'type':'response','id':command['id'],'error':error}))
            size=int.from_bytes(await reader.readexactly(4),sys.byteorder)
            self.assertEqual(json.loads(await reader.readexactly(size))['error'],error)
        finally:
            writer.close();await writer.wait_closed()

    async def test_multiple_profiles_never_silently_selected(self):
        first, one = await self.add_browser("personal")
        second, two = await self.add_browser("work")
        with self.assertRaises(BridgeError) as raised:
            await browser_call("tabs_list", port=self.port)
        self.assertEqual(raised.exception.code, "AMBIGUOUS_BROWSER")
        task = asyncio.create_task(browser_call("tabs_list", browser_id=two, port=self.port))
        message = json.loads(await second.recv())
        await second.send(json.dumps({"type": "response", "id": message["id"], "result": [{"id": 7}]}))
        self.assertEqual(await task, [{"id": 7}])

    async def test_webpages_and_other_extensions_rejected(self):
        for path, origin in [("/client", "https://example.com"), ("/extension", "chrome-extension://" + "a" * 32), ("/extension", None)]:
            with self.subTest(path=path, origin=origin):
                with self.assertRaises(InvalidStatus) as raised:
                    async with connect(f"ws://127.0.0.1:{self.port}{path}", origin=origin):
                        pass
                self.assertEqual(raised.exception.response.status_code, 403)

    async def test_disconnect_resolves_pending_call(self):
        socket, _ = await self.add_browser()
        task = asyncio.create_task(browser_call("page_snapshot", {"tab_id": 9}, port=self.port))
        await socket.recv()
        await socket.close()
        with self.assertRaises(BridgeError) as raised:
            await asyncio.wait_for(task, 2)
        self.assertEqual(raised.exception.code, "DISCONNECTED")
        self.assertFalse(self.bridge.pending)

    async def test_no_browser_is_reported(self):
        with self.assertRaises(BridgeError) as raised:
            await browser_call("google_search", {"query": "こんにちは"}, port=self.port)
        self.assertEqual(raised.exception.code, "NO_BROWSER")

    async def test_managed_websocket_disconnect_ends_original_turn(self):
        _, instance = await self.add_browser(version='0.4.3')
        original = self.bridge.engine.call
        self.bridge.engine.call = AsyncMock(return_value={'id': 1})
        self.bridge.owners.grace = 0
        try:
            async with connect(f'ws://127.0.0.1:{self.port}/client') as client:
                await client.send(json.dumps({'id': 'open', 'method': 'call', 'params': {
                    'browser_id': instance, 'managed_session': True, 'action': 'tab_open',
                    'arguments': {'session_id': 'owned', 'turn_id': 'one', 'url': 'https://example.test'},
                }}))
                self.assertEqual(json.loads(await client.recv())['result'], {'id': 1})
            for _ in range(30):
                if all(not lease.owners for lease in self.bridge.owners.leases.values()):
                    break
                await asyncio.sleep(.01)
            await self.bridge.owners.sweep()
            self.assertEqual(self.bridge.engine.call.await_args.args[1], 'session_end_turn')
            self.assertEqual(self.bridge.engine.call.await_args.args[2], {'session_id': 'owned', 'turn_id': 'one'})
            self.assertFalse(self.bridge.owners.leases)
        finally:
            self.bridge.engine.call = original

    async def test_native_disconnect_delivers_turn_ended_before_releasing_owner(self):
        socket, instance = await self.add_browser(version='0.4.3')
        self.bridge.owners.grace = 0
        reader, writer = await asyncio.open_unix_connection(str(self.bridge.browsers[instance].native_endpoint.path))
        data = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'createTab', 'params': {
            'session_id': 'native-owned', 'turn_id': 'one'}}).encode()
        writer.write(len(data).to_bytes(4, sys.byteorder) + data)
        await writer.drain()
        command = json.loads(await socket.recv())
        await socket.send(json.dumps({'type': 'response', 'id': command['id'], 'result': {'id': 9}}))
        size = int.from_bytes(await reader.readexactly(4), sys.byteorder)
        await reader.readexactly(size)
        writer.close()
        await writer.wait_closed()
        for _ in range(30):
            if all(not lease.owners for lease in self.bridge.owners.leases.values()):
                break
            await asyncio.sleep(.01)
        cleanup = asyncio.create_task(self.bridge.owners.sweep())
        command = json.loads(await asyncio.wait_for(socket.recv(), 2))
        self.assertEqual(command['params']['method'], 'turnEnded')
        self.assertEqual(command['params']['session_id'], 'native-owned')
        await socket.send(json.dumps({'type': 'response', 'id': command['id'], 'result': {}}))
        await cleanup
        self.assertFalse(self.bridge.owners.leases)

    async def test_native_frames_unicode_parallel_requests_and_events(self):
        socket,instance=await self.add_browser(version='0.4.2')
        reader,writer=await asyncio.open_unix_connection(str(self.bridge.browsers[instance].native_endpoint.path))
        def frame(value):
            data=json.dumps(value,ensure_ascii=False).encode()
            return len(data).to_bytes(4,sys.byteorder)+data
        async def receive():
            size=int.from_bytes(await reader.readexactly(4),sys.byteorder)
            return json.loads(await reader.readexactly(size))
        params={'session_id':'native-contract','turn_id':'one','name':'こんにちは'}
        payload=frame({'jsonrpc':'2.0','id':1,'method':'nameSession','params':params})+frame({'jsonrpc':'2.0','id':2,'method':'getTabs','params':params})
        try:
            writer.write(payload[:3]);await writer.drain();writer.write(payload[3:]);await writer.drain()
            commands=[json.loads(await socket.recv()),json.loads(await socket.recv())]
            self.assertEqual(commands[0]['params']['arguments']['name'],'こんにちは')
            self.assertEqual(commands[0]['params']['session_id'],'native-contract')
            for command in reversed(commands):await socket.send(json.dumps({'type':'response','id':command['id'],'result':{'method':command['params']['method']}}))
            replies=[await receive(),await receive()]
            self.assertEqual({r['id'] for r in replies},{1,2})
            await socket.send(json.dumps({'type':'upstream_event','name':'onPageEvent','value':{'text':'通知'}}))
            self.assertEqual(await receive(),{'jsonrpc':'2.0','method':'onPageEvent','params':{'text':'通知'}})
        finally:writer.close();await writer.wait_closed()

    async def test_actual_mcp_client_through_bridge(self):
        socket, _ = await self.add_browser()
        async def extension_response():
            command = json.loads(await socket.recv())
            self.assertEqual(command["action"], "google_search")
            await socket.send(json.dumps({"type": "response", "id": command["id"], "result": {"tab": {"id": 42}, "snapshot": {"text": "こんにちは"}}}, ensure_ascii=False))
            self.assertTrue(command["params"]["session_id"])
            command = json.loads(await socket.recv())
            self.assertEqual(command["action"], "session_end_turn")
            await socket.send(json.dumps({"type":"response", "id":command["id"], "result":{"closed":[],"kept":[42],"released":[]}}))
        responder = asyncio.create_task(extension_response())
        params = StdioServerParameters(
            command=sys.executable, args=["-m", "chrome_bridge.cli", "mcp-compat"],
            env={**os.environ, "CHROME_BRIDGE_PORT": str(self.port)},
        )
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                initialized = await session.initialize()
                self.assertEqual(initialized.serverInfo.name, "local-chrome-bridge")
                names = [tool.name for tool in (await session.list_tools()).tools]
                self.assertIn("browser_screenshot", names)
                result = await session.call_tool("browser_search", {"query": "こんにちは"})
                self.assertFalse(result.isError)
                payload = result.structuredContent or json.loads(result.content[0].text)
                self.assertEqual(payload["tab"]["id"], 42)
                ended = await session.call_tool("browser_end_turn", {})
                self.assertFalse(ended.isError)
        await responder

    @unittest.skipUnless((Path(__file__).resolve().parents[1] / "upstream/browser-engine.mjs").is_file(), "External runtime not installed")
    async def test_real_upstream_engine_through_loopback_rpc_and_stale_snapshot(self):
        socket, instance = await self.add_browser(version="0.4.0")
        nodes=[
            {"nodeId":"1","backendDOMNodeId":1,"frameId":"frame","ignored":False,"role":{"value":"RootWebArea"},"name":{"value":"Test"},"childIds":["2","3"]},
            {"nodeId":"2","backendDOMNodeId":2,"ignored":False,"role":{"value":"button"},"name":{"value":"実行"},"parentId":"1","properties":[]},
            {"nodeId":"3","backendDOMNodeId":3,"ignored":False,"role":{"value":"textbox"},"name":{"value":"比較入力"},"parentId":"1","properties":[{"name":"editable","value":{"value":"plaintext"}}]},
        ]
        document={"strings":["frame","BODY","BUTTON","INPUT","id","entry","type","text"],"documents":[{"frameId":0,"nodes":{"backendNodeId":[1,2,3],"nodeName":[1,2,3],"parentIndex":[-1,0,0],"attributes":[[],[],[4,5,6,7]]},"layout":{"nodeIndex":[0,1,2],"bounds":[[0,0,800,600],[10,10,100,40],[10,60,100,40]]}}]}
        commands=[]
        async def respond():
            try:
                async for raw in socket:
                    message=json.loads(raw)
                    if message.get('type')!='command':continue
                    self.assertEqual(message['action'],'upstream_rpc')
                    params=message['params'];commands.append(params['method'])
                    self.assertEqual(params['session_id'],'contract-test')
                    method=params['method'];args=params['arguments'];result={}
                    tab={"id":7,"title":"Test","url":"https://example.test/","active":True}
                    if method=='getInfo':result={"type":"extension","family":"chrome","name":"Test Chrome"}
                    elif method=='getTabs':result=[tab]
                    elif method=='claimUserTab':result=tab
                    elif method=='executeCdp':
                        cdp=args['method']
                        if cdp=='Page.getFrameTree':result={"frameTree":{"frame":{"id":"frame","loaderId":"document","url":tab['url']}}}
                        elif cdp=='Runtime.evaluate':result={"result":{"value":{"href":tab['url'],"readyState":"complete","painted":True}}}
                        elif cdp=='DOMSnapshot.captureSnapshot':result=document
                        elif cdp=='Accessibility.getFullAXTree':result={"nodes":nodes}
                    await socket.send(json.dumps({"type":"response","id":message['id'],"result":result},ensure_ascii=False))
            except Exception as exc:
                from websockets.exceptions import ConnectionClosed
                if not isinstance(exc,ConnectionClosed):raise
        responder=asyncio.create_task(respond())
        args={"session_id":"contract-test","turn_id":"turn-1","tab_id":7,"disable_diffing":True}
        try:
            first=await browser_call('page_ax_state',args,instance,self.port)
            self.assertIn('button 実行',first['state'])
            nodes[1]['name']['value']='更新済み'
            second=await browser_call('page_ax_state',{**args,'disable_diffing':False},instance,self.port)
            self.assertIn('更新済み',second['state'])
            self.assertNotEqual(first['snapshot_id'],second['snapshot_id'])
            with self.assertRaises(BridgeError) as error:
                await browser_call('page_fill',{**args,'element_index':1,'snapshot_id':first['snapshot_id'],'value':'stale'},instance,self.port)
            self.assertIn('snapshot_id is stale',str(error.exception))
            self.assertIn('attach',commands)
            self.assertIn('executeCdp',commands)
        finally:
            await self.bridge.engine.close()
            await socket.close()
            await responder


if __name__ == "__main__":
    unittest.main()
