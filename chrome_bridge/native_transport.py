"""Original browser JSON-RPC framing over a local Unix socket.

No command handlers, browser selection, observation, recovery or policy logic:
the original Node REPL browser service and extension implement those parts.
"""
import asyncio
import json
import os
from pathlib import Path
import sys
from .protocol import ROOT

MAX_FRAME=32*1024*1024

def native_directory(port):
    directory=Path(f'/tmp/local-chrome-bridge-{os.getuid()}-{port}')
    directory.mkdir(parents=True,exist_ok=True)
    if directory.is_symlink() or directory.stat().st_uid!=os.getuid():raise ValueError('Invalid local socket directory')
    os.chmod(directory,0o700)
    return directory

class NativeEndpoint:
    def __init__(self,bridge,browser):
        self.bridge=bridge;self.browser=browser;self.writers=set();self.server=None;self.closed=False
        # macOS Unix sockets have a short path limit; the workspace is too long.
        self.path=native_directory(bridge.port)/f'{browser.id}.sock'

    async def start(self):
        self.path.unlink(missing_ok=True)
        self.server=await asyncio.start_unix_server(self.handle,path=str(self.path))
        os.chmod(self.path,0o600)

    async def write(self,writer,message):
        body=json.dumps(message,ensure_ascii=False).encode()
        if len(body)>MAX_FRAME:raise ValueError('Native frame too large')
        if writer.transport.get_write_buffer_size() + len(body) > MAX_FRAME:
            writer.close()
            raise ConnectionError('Native client is not consuming events')
        writer.write(len(body).to_bytes(4,sys.byteorder)+body)
        try:
            await asyncio.wait_for(writer.drain(), 5)
        except TimeoutError:
            writer.close()
            raise ConnectionError('Native client event delivery timed out') from None

    async def request(self,writer,message):
        identifier=message.get('id');params=message.get('params') or {}
        try:
            session_id=params.get('session_id');turn_id=params.get('turn_id')
            args={k:v for k,v in params.items() if k not in ('session_id','turn_id','session_context')}
            async def execute():
                return await self.bridge.extension_call(self.browser,'upstream_rpc',{
                'method':message['method'],'arguments':args,'session_id':session_id,
                'turn_id':turn_id,'session_context':params.get('session_context'),
                'notification':identifier is None,
            })
            async def cleanup():
                browser = self.bridge.browsers.get(self.browser.id)
                if browser is None:
                    raise ConnectionError('Browser unavailable for turn cleanup')
                await self.bridge.extension_call(browser, 'upstream_rpc', {
                    'method': 'turnEnded', 'arguments': {}, 'session_id': session_id, 'turn_id': turn_id,
                })
            result = await self.bridge.owned_call(('native-browser', self.browser.id), params,
                ('native', id(writer)), cleanup, execute, message['method'] == 'turnEnded')
            reply={'jsonrpc':'2.0','id':identifier,'result':result}
        except Exception as exc:reply={'jsonrpc':'2.0','id':identifier,'error':getattr(exc,'rpc_error',None) or {'code':1,'message':str(exc)}}
        if identifier is not None:
            try:await self.write(writer,reply)
            except (ConnectionError,BrokenPipeError):pass

    async def handle(self,reader,writer):
        if self.closed:
            writer.close();await writer.wait_closed();return
        self.writers.add(writer);tasks=set()
        try:
            while True:
                size=int.from_bytes(await reader.readexactly(4),sys.byteorder)
                if size>MAX_FRAME:raise ValueError('Native frame too large')
                message=json.loads(await reader.readexactly(size))
                if not isinstance(message,dict) or not isinstance(message.get('method'),str):raise ValueError('Invalid native RPC')
                task=asyncio.create_task(self.request(writer,message));tasks.add(task);task.add_done_callback(tasks.discard)
        except (asyncio.IncompleteReadError,ConnectionError,ValueError):pass
        finally:
            for task in tasks:task.cancel()
            await asyncio.gather(*tasks,return_exceptions=True)
            self.bridge.owners.disconnect(('native', id(writer)))
            self.writers.discard(writer);writer.close();await writer.wait_closed()

    async def event(self,name,*values):
        async def send(writer):
            try:await self.write(writer,{'jsonrpc':'2.0','method':name,**({'params':values[0]} if values else {})})
            except (ConnectionError,BrokenPipeError):pass
        await asyncio.gather(*(send(w) for w in tuple(self.writers)))

    async def close(self):
        if self.closed:return
        self.closed=True
        if self.server:self.server.close()
        writers=tuple(self.writers)
        for writer in writers:writer.close()
        await asyncio.gather(*(writer.wait_closed() for writer in writers),return_exceptions=True)
        if self.server:await self.server.wait_closed()
        self.path.unlink(missing_ok=True)
