import asyncio,json,os,sys,unittest
from unittest.mock import AsyncMock
from chrome_bridge.daemon import Bridge
from chrome_bridge.protocol import ROOT

class McpRelayTests(unittest.IsolatedAsyncioTestCase):
    async def test_preserves_rich_content_and_server_requests_and_waits_for_reset_cleanup(self):
        bridge=Bridge(0);server=await bridge.serve();bridge.port=server.sockets[0].getsockname()[1]
        cleanup=AsyncMock();key=('native-browser','fixture','chat','turn')
        bridge.owners.acquire(key,('native',1),cleanup);bridge.owners.release_call(key)
        code='import asyncio,os;from chrome_bridge.mcp_transport import relay;asyncio.run(relay('+repr(str(ROOT/'tests/fixtures/mcp-wire.py'))+',os.environ.copy(),'+str(bridge.port)+'))'
        process=await asyncio.create_subprocess_exec(sys.executable,'-c',code,cwd=ROOT,stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
        async def send(value):process.stdin.write((json.dumps(value)+'\n').encode());await process.stdin.drain()
        async def receive():return json.loads(await asyncio.wait_for(process.stdout.readline(),5))
        try:
            params={'name':'js','arguments':{'code':'original code'},'_meta':{'x-codex-turn-metadata':json.dumps({'session_id':'chat','turn_id':'turn'})}}
            await send({'jsonrpc':'2.0','id':1,'method':'tools/call','params':params})
            result=(await receive())['result']
            self.assertEqual(result['structuredContent'],params)
            self.assertEqual(result['_meta'],{'original':True})
            self.assertEqual(result['content'][1],{'type':'image','mimeType':'image/png','data':'AA=='})
            await send({'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'js_reset','arguments':{}}})
            prompt=await receive();self.assertEqual(prompt['method'],'elicitation/create');self.assertEqual(prompt['id'],2)
            cleanup.assert_not_awaited()
            await send({'jsonrpc':'2.0','id':2,'result':{'action':'decline'}})
            reset=await receive();self.assertEqual(reset['result'],{'content':[],'_meta':{'originalReset':True}})
            cleanup.assert_awaited_once();self.assertNotIn(key,bridge.owners.leases)
            cancelled={'jsonrpc':'2.0','method':'notifications/cancelled','params':{'requestId':99}}
            await send(cancelled);self.assertEqual((await receive())['params'],cancelled)
            process.stdin.close();await asyncio.wait_for(process.wait(),5);self.assertEqual(process.returncode,0)
        finally:
            if process.returncode is None:process.terminate();await process.wait()
            await bridge.close();server.close();await server.wait_closed()
