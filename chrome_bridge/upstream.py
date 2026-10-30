"""Node host for the unchanged upstream browser engines, using loopback RPC."""
import asyncio
import json
import logging
import os
from pathlib import Path
import shutil
import time
import uuid

from .protocol import BridgeError, ROOT

ENGINE_ACTIONS = frozenset({
    'session_name','session_tabs','session_end_turn','tab_open','google_search',
    'tab_navigate','tab_reload','tab_back','tab_forward','tab_focus',
    'tab_claim','tab_mark','tab_close','page_snapshot','page_click','page_fill',
    'page_wait_for','page_scroll','page_ax_state','page_ax_action','screenshot','page_key','page_type','page_drag',
    'page_select','page_check','page_secondary',
    'browser_command','runtime_setup','runtime_after_code','windows_list',
    'group_create','group_update','tabs_ungroup',
})

log = logging.getLogger("chrome_bridge.upstream")


class UpstreamEngine:
    def __init__(self, bridge):
        self.bridge = bridge
        self.process = None
        self.reader = None
        self.pending = {}
        self.tasks = set()
        self.elicitation_callbacks = {}
        self.start_lock = asyncio.Lock()

    def trace(self, event, started, **fields):
        path = os.environ.get('CHROME_BRIDGE_TRACE')
        if path:
            record = {'event': event, 'seconds': round(time.perf_counter()-started, 6), **fields}
            with open(path, 'a', encoding='utf-8') as output:
                output.write(json.dumps(record, ensure_ascii=False)+'\n')

    async def start(self):
        async with self.start_lock:
            if self.process and self.process.returncode is None:
                return
            local = ROOT/'.runtime/node'
            node = os.environ.get('CHROME_BRIDGE_NODE') or (str(local) if local.exists() else shutil.which('node'))
            if not node:
                raise BridgeError('NODE_REQUIRED','Node.js 22以降をインストールしてください。')
            self.process = await asyncio.create_subprocess_exec(
                node, str(ROOT/'upstream/engine-worker.mjs'),
                stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,
                limit=32*1024*1024,
            )
            self.reader = asyncio.create_task(self.read())

    async def send(self, message):
        if self.process is None or self.process.returncode is not None:
            return
        self.process.stdin.write((json.dumps(message,ensure_ascii=False)+'\n').encode())
        await self.process.stdin.drain()

    async def read(self):
        try:
            while raw := await self.process.stdout.readline():
                message = json.loads(raw)
                if message.get('type') == 'rpc':
                    task = asyncio.create_task(self.rpc(message))
                    self.tasks.add(task)
                    task.add_done_callback(self.tasks.discard)
                elif message.get('type') == 'elicitation':
                    task = asyncio.create_task(self.elicit(message))
                    self.tasks.add(task)
                    task.add_done_callback(self.tasks.discard)
                elif message.get('type') == 'result':
                    future = self.pending.get(message['id'])
                    if future and not future.done():
                        if 'error' in message:
                            future.set_exception(BridgeError('UPSTREAM_FAILED',message['error']))
                        else:
                            future.set_result(message.get('result'))
        finally:
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(BridgeError('UPSTREAM_OFFLINE','Upstream engine exited'))

    async def rpc(self, message):
        started = time.perf_counter()
        try:
            log.info("Upstream RPC: %s", message['method'])
            browser = self.bridge.browsers.get(message['browser_id'])
            if browser is None:
                raise BridgeError('NO_BROWSER','Chrome拡張が切断されました。')
            result = await self.bridge.extension_call(browser,'upstream_rpc',{
                'method':message['method'],'arguments':message['arguments'],
                'session_id':message['session_id'],'turn_id':message['turn_id'],
                'session_context':message.get('session_context'),
                'notification':message.get('notification',False),
            })
            await self.send({'type':'rpc_result','id':message['id'],'result':result})
        except Exception as exc:
            await self.send({'type':'rpc_result','id':message['id'],'error':str(exc)})
        finally:
            self.trace('rpc', started, method=message['method'], cdp=message['arguments'].get('method'), session_id=message['session_id'])

    async def elicit(self, message):
        try:
            callback = self.elicitation_callbacks.get(message.get('request_id'))
            if callback is None:
                raise BridgeError('USER_INTERACTION_REQUIRED','This MCP client does not provide an approval UI. No approval was granted.')
            result = await callback(message['request'])
            await self.send({'type':'elicitation_result','id':message['id'],'result':result})
        except Exception as exc:
            await self.send({'type':'elicitation_result','id':message['id'],'error':str(exc)})

    async def call(self, browser, action, arguments, elicitation_callback=None):
        started = time.perf_counter()
        await self.start()
        key = str(uuid.uuid4())
        future = asyncio.get_running_loop().create_future()
        self.pending[key] = future
        if elicitation_callback is not None:
            self.elicitation_callbacks[key] = elicitation_callback
        try:
            await self.send({'type':'call','id':key,'browser_id':browser.id if browser else None,'action':action,'arguments':arguments})
            try:
                return await asyncio.wait_for(future,90)
            except TimeoutError:
                raise BridgeError('UPSTREAM_TIMEOUT','操作の完了を確認できません。操作を繰り返す前に画面を確認してください。') from None
        finally:
            self.pending.pop(key,None)
            self.elicitation_callbacks.pop(key,None)
            self.trace('call', started, action=action, command=arguments.get('command',{}).get('type'), session_id=arguments.get('session_id'))

    async def event(self, browser, name, *values):
        await self.send({'type':'event','browser_id':browser.id,'name':name,**({'value':values[0]} if values else {})})

    async def close(self):
        if self.process and self.process.returncode is None:
            self.process.stdin.close()
            try:
                await asyncio.wait_for(self.process.wait(),3)
            except TimeoutError:
                self.process.terminate()
                await self.process.wait()
