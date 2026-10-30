import asyncio
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

from chrome_bridge.lifecycle import SessionOwners
from chrome_bridge.protocol import BridgeError


class OwnershipTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.now = 0
        self.alive = True
        self.owners = SessionOwners(grace=15, clock=lambda: self.now, alive=lambda _: self.alive)
        self.cleanup = AsyncMock()
        self.key = ('browser', 'profile', 'session', 'turn')

    async def asyncTearDown(self):
        self.owners.leases.clear()
        await self.owners.close()

    def acquire(self, owner):
        self.owners.acquire(self.key, owner, self.cleanup)
        self.owners.release_call(self.key)

    async def test_one_shot_connections_keep_live_process_then_reap_dead_owner(self):
        owner = ('process', 123, 'token')
        for _ in range(100):
            self.acquire(owner)
            self.owners.disconnect(('connection', 'one-shot'))
        self.now = 10000
        await self.owners.sweep()
        self.cleanup.assert_not_awaited()
        self.alive = False
        await self.owners.sweep()
        self.now += 16
        await self.owners.sweep()
        self.cleanup.assert_awaited_once()
        self.assertFalse(self.owners.leases)

    async def test_reconnect_and_other_owner_cancel_reaping(self):
        a, b = ('connection', 1), ('native', 2)
        self.acquire(a)
        self.owners.disconnect(a)
        self.now = 10
        self.acquire(b)
        self.now = 40
        await self.owners.sweep()
        self.cleanup.assert_not_awaited()
        self.owners.disconnect(b)
        self.now = 56
        await self.owners.sweep()
        self.cleanup.assert_awaited_once()

    async def test_cleanup_failure_is_retained_and_blocks_stale_session_reuse(self):
        self.cleanup.side_effect = [RuntimeError('offline'), None]
        owner = ('connection', 1)
        self.acquire(owner)
        self.owners.disconnect(owner)
        self.now = 16
        await self.owners.sweep()
        self.assertEqual(self.owners.leases[self.key].error, 'offline')
        with self.assertRaises(BridgeError):
            self.acquire(owner)
        self.now = 32
        await self.owners.sweep()
        self.assertFalse(self.owners.leases)

    async def test_in_flight_command_is_not_reaped_and_explicit_end_removes_lease(self):
        owner = ('connection', 1)
        self.owners.acquire(self.key, owner, self.cleanup)
        self.owners.disconnect(owner)
        self.now = 100
        await self.owners.sweep()
        self.cleanup.assert_not_awaited()
        self.owners.release_call(self.key, ended=True)
        self.assertFalse(self.owners.leases)


if __name__ == '__main__':
    unittest.main()

class ExplicitNativeBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_reset_cleanup_matches_exact_turn_and_keeps_other_chat(self):
        from chrome_bridge.lifecycle import SessionOwners
        from unittest.mock import AsyncMock
        owners=SessionOwners()
        a,b=AsyncMock(),AsyncMock()
        one=('native-browser','profile','A','one');two=('native-browser','profile','B','one')
        try:
            owners.acquire(one,('native',1),a);owners.release_call(one)
            owners.acquire(two,('native',2),b);owners.release_call(two)
            self.assertEqual(await owners.end_native_turn('A','one'),{'ended':1})
            a.assert_awaited_once();b.assert_not_awaited()
            self.assertIn(two,owners.leases)
            self.assertEqual(await owners.end_native_turn('A','one'),{'ended':0})
        finally:await owners.close()

    async def test_failed_explicit_cleanup_is_not_reported_as_success(self):
        from chrome_bridge.lifecycle import SessionOwners
        from unittest.mock import AsyncMock
        owners=SessionOwners()
        key=('native-browser','profile','A','one')
        try:
            owners.acquire(key,('native',1),AsyncMock(side_effect=RuntimeError('offline')))
            owners.release_call(key)
            with self.assertRaisesRegex(RuntimeError,'offline'):
                await owners.end_native_turn('A','one')
            self.assertTrue(owners.leases[key].closing)
            self.assertEqual(owners.leases[key].error,'offline')
        finally:owners.leases.clear();await owners.close()
