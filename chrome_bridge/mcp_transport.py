"""Byte-preserving stdio relay; only reset/end acknowledgements own cleanup.

The vendor process owns tools/list, schemas, execution, content, elicitation,
cancellation and notifications. No browser operation is implemented here.
"""
import asyncio
import json
import signal
import sys
from .client import request


def turn_metadata(message):
    params = message.get('params') or {}
    value = (params.get('_meta') or {}).get('x-codex-turn-metadata')
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return None
    if not isinstance(value, dict):
        return None
    sid, tid = value.get('session_id'), value.get('turn_id')
    return (sid, tid) if isinstance(sid, str) and sid and isinstance(tid, str) and tid else None


async def relay(executable, environment, port):
    loop = asyncio.get_running_loop()
    current = asyncio.current_task()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, current.cancel)
    child = await asyncio.create_subprocess_exec(executable, env=environment,
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        limit=40 * 1024 * 1024)
    reader = asyncio.StreamReader(limit=40 * 1024 * 1024)
    protocol = asyncio.StreamReaderProtocol(reader)
    transport, _ = await asyncio.get_running_loop().connect_read_pipe(lambda: protocol, sys.stdin.buffer)
    pending = {}
    turns = set()

    async def forward_input():
        while line := await reader.readline():
            try:
                message = json.loads(line)
                params = message.get('params') or {}
                if message.get('method') == 'tools/call':
                    name = params.get('name')
                    meta = turn_metadata(message)
                    if meta:
                        turns.add(meta)
                    if name == 'turn_ended':
                        args = params.get('arguments') or {}
                        sid, tid = args.get('session_id'), args.get('turn_id')
                        targets = {(sid, tid)} if isinstance(sid, str) and isinstance(tid, str) else set()
                        pending[message['id']] = targets
                    elif name == 'js_reset':
                        pending[message['id']] = set(turns)
            except (ValueError, TypeError, KeyError, AttributeError):
                pass  # The original MCP validates malformed input and owns its reply.
            child.stdin.write(line)
            await child.stdin.drain()
        child.stdin.close()

    async def forward_output():
        while line := await child.stdout.readline():
            message = json.loads(line)
            targets = pending.pop(message.get('id'), None) if 'result' in message or 'error' in message else None
            if targets is not None and 'error' not in message and not message.get('result', {}).get('isError'):
                try:
                    for sid, tid in targets:
                        await request('native_turn_ended', {'session_id': sid, 'turn_id': tid}, port=port)
                        turns.discard((sid, tid))
                except Exception as exc:
                    # Do not acknowledge reset/end as successful while tabs remain owned.
                    message['result'] = {'isError': True, 'content': [{'type': 'text',
                        'text': 'Original browser turn cleanup failed: ' + str(exc)}]}
                    line = (json.dumps(message, ensure_ascii=False) + '\n').encode()
            sys.stdout.buffer.write(line)
            sys.stdout.buffer.flush()

    tasks = [asyncio.create_task(forward_input()), asyncio.create_task(forward_output())]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
        if tasks[0] in done:
            await tasks[1]
        await child.wait()
    finally:
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.remove_signal_handler(sig)
        transport.close()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if child.returncode is None:
            child.terminate()
            try:
                await asyncio.wait_for(child.wait(), 5)
            except TimeoutError:
                child.kill()
                await child.wait()
