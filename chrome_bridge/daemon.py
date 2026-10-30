from __future__ import annotations

import asyncio
from dataclasses import dataclass
from http import HTTPStatus
import json
import logging
import signal
import time
import uuid

from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

from .protocol import ACTIONS, DEFAULT_PORT, BridgeError, extension_id
from .upstream import UpstreamEngine, ENGINE_ACTIONS
from .native_transport import NativeEndpoint
from .lifecycle import SessionOwners

log = logging.getLogger("chrome_bridge")


@dataclass
class Browser:
    id: str
    label: str
    socket: object
    connected_at: float
    version: str = "unknown"
    native_endpoint: object = None


class Bridge:
    def __init__(self, port: int = DEFAULT_PORT, *, native: bool = True):
        self.port = port
        self.native = native
        self.browsers: dict[str, Browser] = {}
        self.pending: dict[str, tuple[object, asyncio.Future]] = {}
        self.origin = "chrome-extension://" + extension_id()
        self.engine = UpstreamEngine(self)
        self.engines = {}
        self.elicitation_replies = {}
        self.owners = SessionOwners()
        self.runtime_connections = {}
        self.runtime_closers = set()

    def check_request(self, connection, request):
        try:
            host = request.headers.get("Host", "")
            origin = request.headers.get("Origin")
        except Exception:
            return connection.respond(HTTPStatus.BAD_REQUEST, "Invalid headers\n")
        if host not in {f"127.0.0.1:{self.port}", f"localhost:{self.port}"}:
            return connection.respond(HTTPStatus.FORBIDDEN, "Loopback host required\n")
        if request.path == "/extension" and origin == self.origin:
            return None
        if request.path == "/client" and origin is None:
            return None
        return connection.respond(HTTPStatus.FORBIDDEN, "Origin or path not allowed\n")

    async def handle(self, socket):
        if socket.request.path == "/extension":
            await self.extension(socket)
        else:
            await self.client(socket)

    def disconnect_pending(self, socket):
        for key, (owner, future) in list(self.pending.items()):
            if owner is socket:
                if not future.done():
                    future.set_exception(BridgeError("DISCONNECTED", "Chrome拡張との接続が切れました。"))
                self.pending.pop(key, None)

    async def extension(self, socket):
        browser = None
        try:
            hello = json.loads(await asyncio.wait_for(socket.recv(), 5))
            if hello.get("type") != "hello" or hello.get("protocol") != 1:
                raise ValueError("Protocol mismatch")
            instance = str(uuid.UUID(hello["instance_id"]))
            label = str(hello.get("label", "Chrome"))[:80]
            previous = self.browsers.get(instance)
            if previous:
                self.disconnect_pending(previous.socket)
                if previous.native_endpoint:await previous.native_endpoint.close()
                await previous.socket.close(1000, "Replaced by reconnected extension")
            browser = Browser(instance, label, socket, time.time(), str(hello.get("version","unknown")))
            self.browsers[instance] = browser
            if self.native:
                browser.native_endpoint=NativeEndpoint(self,browser);await browser.native_endpoint.start()
            await socket.send(json.dumps({"type": "welcome", "protocol": 1}))
            log.info("Chrome extension connected: %s (%s)", label, instance)
            async for raw in socket:
                message = json.loads(raw)
                if message.get("type") == "heartbeat":
                    await socket.send('{"type":"heartbeat_ack"}')
                elif message.get("type") == "upstream_event":
                    values=(message['value'],) if 'value' in message else ()
                    if browser.native_endpoint:
                        await browser.native_endpoint.event(message['name'],*values)
                    await self.engine.event(browser,message['name'],*values)
                    await asyncio.gather(*(engine.event(browser,message['name'],*values) for engine in tuple(self.engines.values())))
                elif message.get("type") == "response":
                    item = self.pending.get(message.get("id"))
                    if item and item[0] is socket and not item[1].done():
                        if "error" in message:
                            error = message["error"]
                            failure=BridgeError(error.get("code", "ACTION_FAILED"), error.get("message", "Chrome action failed"))
                            failure.rpc_error=error
                            item[1].set_exception(failure)
                        else:
                            item[1].set_result(message.get("result"))
        except ConnectionClosed:
            pass
        except (ValueError, KeyError, TimeoutError) as exc:
            log.warning("Invalid extension handshake/message: %s", exc)
            await socket.close(1008, "Invalid protocol")
        finally:
            self.disconnect_pending(socket)
            if browser and self.browsers.get(browser.id) is browser:
                if browser.native_endpoint:await browser.native_endpoint.close()
                self.browsers.pop(browser.id, None)
                log.info("Chrome extension disconnected: %s", browser.id)

    async def dispatch(self, method: str, params: dict, elicitation_callback=None, owner=None):
        if method == 'elicitation_reply':
            future = self.elicitation_replies.get(params.get('elicitation_id'))
            if future is None or future.done():
                raise BridgeError('BAD_ELICITATION','Unknown or expired approval request')
            if 'error' in params:
                future.set_exception(BridgeError('USER_INTERACTION_REQUIRED',str(params['error'])))
            else:
                future.set_result(params['result'])
            return {}
        if method == 'native_turn_ended':
            sid, tid = params.get('session_id'), params.get('turn_id')
            if not isinstance(sid, str) or not sid or not isinstance(tid, str) or not tid:
                raise BridgeError('BAD_REQUEST', 'session_id and turn_id are required')
            return await self.owners.end_native_turn(sid, tid)
        if method == "status":
            return {
                "product": "ChromeMCP",
                "protocol": 1,
                "extension_id": extension_id(),
                "managed_sessions": len(self.owners.leases),
                "cleanup_pending": sum(bool(x.error) for x in self.owners.leases.values()),
                "browsers": [{"id": x.id, "label": x.label, "version": x.version,**({'native_path':str(x.native_endpoint.path)} if x.native_endpoint else {})} for x in self.browsers.values()],
            }
        if method != "call":
            raise BridgeError("BAD_METHOD", "Unknown bridge method")
        action = params.get("action")
        if action not in ACTIONS:
            raise BridgeError("BAD_ACTION", "Unsupported browser action")
        runtime_id=params.get('runtime_id')
        if runtime_id is not None:
            try:runtime_id=str(uuid.UUID(runtime_id))
            except (ValueError,TypeError,AttributeError):raise BridgeError('BAD_REQUEST','Invalid runtime ID') from None
            if action not in ENGINE_ACTIONS:raise BridgeError('BAD_ACTION','Unsupported native runtime action')
            arguments=params.get('arguments',{})
            if not isinstance(arguments,dict):raise BridgeError('BAD_REQUEST','arguments must be an object')
            engine=self.engines.setdefault(runtime_id,UpstreamEngine(self))
            arguments={**arguments,'native_runtime':True,'connected_browsers':[{'id':b.id} for b in self.browsers.values()]}
            context = {k: arguments[k] for k in ('session_id', 'turn_id') if k in arguments}
            async def cleanup():
                await engine.call(None, 'session_end_turn', {**context, 'connected_browsers': [{'id': b.id} for b in self.browsers.values()]})
            return await self.owned_call(('runtime', runtime_id), arguments, owner, cleanup,
                                         lambda: engine.call(None,action,arguments,elicitation_callback),
                                         action == 'session_end_turn')
        browser_id = params.get("browser_id")
        if browser_id is None:
            if not self.browsers:
                raise BridgeError("NO_BROWSER", "Chrome拡張が未接続です。拡張をインストールし、接続表示を確認してください。")
            if len(self.browsers) != 1:
                raise BridgeError("AMBIGUOUS_BROWSER", "複数プロファイルが接続中です。browser_idを指定してください。")
            browser = next(iter(self.browsers.values()))
        else:
            browser = self.browsers.get(browser_id)
            if browser is None:
                raise BridgeError("NO_BROWSER", "指定のChromeプロファイルは接続されていません。")
        arguments = params.get("arguments", {})
        if not isinstance(arguments, dict):
            raise BridgeError("BAD_REQUEST", "arguments must be an object")
        if browser.version.startswith(('0.3.','0.4.','0.5.','0.6.')) and action in ENGINE_ACTIONS:
            context = {k: arguments[k] for k in ('session_id', 'turn_id') if k in arguments}
            async def cleanup():
                current = self.browsers.get(browser.id)
                if current is None:
                    raise BridgeError('NO_BROWSER', 'Chrome再接続後に終了処理を再試行します。')
                await self.engine.call(current, 'session_end_turn', context)
            return await self.owned_call(('browser', browser.id), arguments, owner, cleanup,
                                         lambda: self.engine.call(browser,action,arguments,elicitation_callback),
                                         action == 'session_end_turn')
        if action=='page_ax_state':
            result=await self.extension_call(browser,'page_snapshot',arguments)
            return {'state':result['ax_tree'],'snapshot_id':result['snapshot_id']}
        return await self.extension_call(browser,action,arguments)

    async def owned_call(self, scope, arguments, owner, cleanup, execute, ending=False):
        sid, tid = arguments.get('session_id'), arguments.get('turn_id')
        if owner is None or not sid or not tid:
            return await execute()
        key = (*scope, sid, tid)
        self.owners.acquire(key, owner, cleanup)
        ended = False
        try:
            result = await execute()
            ended = ending
            return result
        except BaseException as exc:
            if ending:
                self.owners.cleanup_failed(key, exc)
            raise
        finally:
            self.owners.release_call(key, ended)

    async def extension_call(self, browser, action, arguments):
        request_id = str(uuid.uuid4())
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = (browser.socket, future)
        try:
            await browser.socket.send(json.dumps({
                "type": "command", "id": request_id, "action": action, "params": arguments,
            }, ensure_ascii=False))
            # Only operation names are logged, never page content or input values.
            log.info("Browser action: %s", action)
            # The original native runtime owns command deadlines and cancellation.
            # Retain the legacy bridge deadline only for the compatibility API.
            return await future if action == 'upstream_rpc' else await asyncio.wait_for(future, 35)
        except TimeoutError:
            raise BridgeError("TIMEOUT", "Chromeからの応答が35秒以内に届きませんでした。") from None
        except ConnectionClosed:
            raise BridgeError("DISCONNECTED", "Chrome拡張との接続が切れました。") from None
        finally:
            self.pending.pop(request_id, None)

    async def client(self, socket):
        tasks=set();runtime_ids=set()
        connection_owner = ('connection', id(socket))
        async def handle_request(raw):
            request_id = None
            try:
                message = json.loads(raw)
                request_id = message.get("id")
                params = message.get("params", {})
                if not isinstance(request_id, str) or not isinstance(params, dict):
                    raise BridgeError("BAD_REQUEST", "id must be a string and params must be an object")
                owner = None
                if params.get('managed_session') is True or params.get('runtime_id') is not None:
                    owner = connection_owner
                elif 'owner_pid' in params:
                    pid, token = params.get('owner_pid'), params.get('owner_id')
                    if type(pid) is not int or pid <= 1 or not isinstance(token, str) or not token:
                        raise BridgeError('BAD_REQUEST', 'Invalid process owner')
                    owner = ('process', pid, token)
                if params.get('runtime_id') is not None:
                    try:
                        params['runtime_id'] = str(uuid.UUID(params['runtime_id']))
                        runtime_ids.add(params['runtime_id'])
                    except (ValueError,TypeError,AttributeError):raise BridgeError('BAD_REQUEST','Invalid runtime ID') from None
                    self.runtime_connections.setdefault(params['runtime_id'], set()).add(connection_owner)
                async def elicit(request):
                    key=str(uuid.uuid4());future=asyncio.get_running_loop().create_future();self.elicitation_replies[key]=future
                    try:
                        await socket.send(json.dumps({'type':'elicitation','elicitation_id':key,'request':request},ensure_ascii=False))
                        return await asyncio.wait_for(future,90)
                    finally:self.elicitation_replies.pop(key,None)
                result = await self.dispatch(message.get("method"), params, elicit if params.get('supports_elicitation') is True else None, owner)
                reply = {"id": request_id, "result": result}
            except BridgeError as exc:
                reply = {"id": request_id, "error": exc.as_dict()}
            except (ValueError, TypeError, AttributeError):
                reply = {"id": request_id, "error": {"code": "BAD_REQUEST", "message": "Invalid JSON request"}}
            try:
                await socket.send(json.dumps(reply, ensure_ascii=False))
            except ConnectionClosed:
                return
        try:
            async for raw in socket:
                task=asyncio.create_task(handle_request(raw));tasks.add(task);task.add_done_callback(tasks.discard)
        except ConnectionClosed:pass
        finally:
            for task in tasks:task.cancel()
            await asyncio.gather(*tasks,return_exceptions=True)
            self.owners.disconnect(connection_owner)
            for runtime_id in runtime_ids:
                self.runtime_connections.get(runtime_id, set()).discard(connection_owner)
                task = asyncio.create_task(self.close_idle_runtime(runtime_id))
                self.runtime_closers.add(task)
                task.add_done_callback(self.runtime_closers.discard)

    async def close_idle_runtime(self, runtime_id):
        await asyncio.sleep(self.owners.grace + 2)
        while not self.runtime_connections.get(runtime_id):
            if any(key[:2] == ('runtime', runtime_id) for key in self.owners.leases):
                await asyncio.sleep(2)
                continue
            engine = self.engines.pop(runtime_id, None)
            self.runtime_connections.pop(runtime_id, None)
            if engine:
                await engine.close()
            return

    async def close(self):
        for task in self.runtime_closers:
            task.cancel()
        await asyncio.gather(*self.runtime_closers, return_exceptions=True)
        await self.owners.close()
        await self.engine.close()
        await asyncio.gather(*(engine.close() for engine in tuple(self.engines.values())))

    def serve(self):
        return serve(
            self.handle, "127.0.0.1", self.port,
            process_request=self.check_request,
            max_size=32 * 1024 * 1024, ping_interval=20, ping_timeout=20,
        )


async def run_daemon(port: int):
    bridge = Bridge(port)
    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    try:
        async with bridge.serve():
            try:
                print(f"Chrome bridge ready: ws://127.0.0.1:{port}\nExtension ID: {extension_id()}", flush=True)
                await stop.wait()
            finally:
                # Keep extension transport alive until its original turnEnded completes.
                await bridge.close()
    finally:
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.remove_signal_handler(sig)
