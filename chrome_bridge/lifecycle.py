"""Transport ownership only; all tab cleanup remains in the upstream backend."""
import asyncio
from dataclasses import dataclass, field
import logging
import os
import time
from .protocol import BridgeError

log = logging.getLogger(__name__)


def process_alive(pid):
    if os.name == 'nt':
        # os.kill(pid, 0) is not a safe liveness probe on Windows.
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return ctypes.get_last_error() == 5  # Access denied: assume alive.
        try:
            code = wintypes.DWORD()
            return not kernel.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value == 259
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


@dataclass
class Lease:
    cleanup: object
    owners: set = field(default_factory=set)
    active: int = 0
    deadline: float | None = None
    error: str | None = None
    closing: bool = False
    idle: asyncio.Event = field(default_factory=asyncio.Event)
    cleanup_lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class SessionOwners:
    def __init__(self, grace=15, clock=time.monotonic, alive=process_alive):
        self.grace, self.clock, self.alive = grace, clock, alive
        self.leases = {}
        self.task = None

    def acquire(self, key, owner, cleanup):
        lease = self.leases.setdefault(key, Lease(cleanup))
        if lease.closing:
            raise BridgeError('SESSION_ENDING', '終了処理中です。新しい操作セッションで再開してください。')
        lease.owners.add(owner)
        lease.deadline = None
        lease.active += 1
        lease.idle.clear()
        if self.task is None or self.task.done():
            self.task = asyncio.create_task(self.watch())

    def release_call(self, key, ended=False):
        lease = self.leases.get(key)
        if lease:
            lease.active -= 1
            if not lease.active:
                lease.idle.set()
            if ended:
                self.leases.pop(key, None)

    def disconnect(self, owner):
        for lease in self.leases.values():
            lease.owners.discard(owner)
            if not lease.owners and lease.deadline is None:
                lease.deadline = self.clock() + self.grace

    def cleanup_failed(self, key, error):
        """A terminal host event ends ownership even if its first cleanup failed."""
        lease = self.leases.get(key)
        if lease:
            lease.owners.clear()
            lease.closing = True
            lease.error = str(error) or type(error).__name__
            lease.deadline = self.clock() + self.grace
            log.warning('Turn cleanup pending (%s): %s', key, lease.error)

    async def end_native_turn(self, session_id, turn_id):
        """Forward an explicit host boundary after the original kernel resets.

        A reset drops the original runtime's registered cleanup handlers. The
        native transport retains the same backend turnEnded callback and IDs.
        Never select tabs by URL or create a second tab-cleanup implementation.
        """
        matches = [(key, lease) for key, lease in self.leases.items()
                   if key[0] == 'native-browser' and key[-2:] == (session_id, turn_id)]
        for key, lease in matches:
            lease.closing = True
            lease.owners.clear()
            try:
                if lease.active:
                    await asyncio.wait_for(lease.idle.wait(), 40)
                async with lease.cleanup_lock:
                    if self.leases.get(key) is lease:
                        await asyncio.wait_for(lease.cleanup(), 40)
            except Exception as exc:
                self.cleanup_failed(key, exc)
                raise
            else:
                if self.leases.get(key) is lease:
                    self.leases.pop(key, None)
        return {'ended': len(matches)}

    async def sweep(self):
        for key, lease in list(self.leases.items()):
            for owner in tuple(lease.owners):
                if owner[0] == 'process' and not self.alive(owner[1]):
                    lease.owners.discard(owner)
            if lease.owners or lease.active or lease.cleanup_lock.locked():
                continue
            if lease.deadline is None:
                lease.deadline = self.clock() + self.grace
            if self.clock() < lease.deadline:
                continue
            try:
                lease.closing = True
                async with lease.cleanup_lock:
                    await asyncio.wait_for(lease.cleanup(), 40)
            except Exception as exc:
                lease.error = str(exc)
                lease.deadline = self.clock() + self.grace
                log.warning('Session cleanup pending (%s): %s', key, exc)
            else:
                if self.leases.get(key) is lease:
                    self.leases.pop(key, None)

    async def watch(self):
        while self.leases:
            await asyncio.sleep(2)
            await self.sweep()

    async def close(self):
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
        # Shutdown calls the same original cleanup, while transports still exist.
        for lease in list(self.leases.values()):
            try:
                await asyncio.wait_for(lease.cleanup(), 5)
            except Exception as exc:
                log.warning('Session cleanup on shutdown failed: %s', exc)
        self.leases.clear()
