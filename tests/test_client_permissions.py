import asyncio
import json
import unittest
from websockets.asyncio.server import serve
from chrome_bridge.client import browser_call
from chrome_bridge.protocol import BridgeError


class PermissionForwardingTests(unittest.IsolatedAsyncioTestCase):
    async def exercise(self, action):
        observed = []
        async def handler(socket):
            request = json.loads(await socket.recv())
            self.assertTrue(request['params']['supports_elicitation'])
            await socket.send(json.dumps({'type': 'elicitation', 'elicitation_id': 'permission', 'request': {'message': 'Test fixture permission', 'meta': {'origin': 'https://example.test'}}}))
            reply = json.loads(await socket.recv())
            observed.append(reply['params']['result'])
            await socket.send(json.dumps({'id': reply['id'], 'result': {}}))
            response = {'result': {'completed': True}} if action == 'accept' else {'error': {'code': 'DENIED', 'message': 'User declined'}}
            await socket.send(json.dumps({'id': request['id'], **response}))
        async def callback(request):
            self.assertEqual(request['meta']['origin'], 'https://example.test')
            # Protocol fixture only; no actual browser or permission is involved.
            return {'action': action, 'content': {}}
        async with serve(handler, '127.0.0.1', 0) as server:
            port = server.sockets[0].getsockname()[1]
            operation = browser_call('tab_open', {'url': 'https://example.test'}, port=port, elicitation_callback=callback)
            if action == 'accept':
                self.assertEqual(await operation, {'completed': True})
            else:
                with self.assertRaises(BridgeError) as caught:
                    await operation
                self.assertEqual(caught.exception.code, 'DENIED')
        self.assertEqual(observed, [{'action': action, 'content': {}}])

    async def test_client_accept_is_forwarded(self):
        await self.exercise('accept')

    async def test_client_decline_remains_a_failure(self):
        await self.exercise('decline')
