"""Host turn end is independent of the persistent MCP process lifetime."""
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from chrome_bridge import mcp_server as server
from chrome_bridge.daemon import Bridge
from chrome_bridge.lifecycle import SessionOwners


def context(sid, tid):
    return SimpleNamespace(request_context=SimpleNamespace(meta=SimpleNamespace(
        model_extra={'x-codex-turn-metadata': {'session_id': sid, 'turn_id': tid}})))


class TurnHookTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        server._seen_contexts.clear()

    async def test_open_omits_unspecified_window_for_upstream_window_selection(self):
        with patch.object(server, 'browser_call', new_callable=AsyncMock) as call:
            await server.browser_open(context('s', 't'), 'http://localhost/', browser_id='a')
            self.assertNotIn('window_id', call.await_args.args[1])

    async def test_end_all_profiles_only_for_matching_chat_and_turn(self):
        with patch.object(server, 'browser_call', new_callable=AsyncMock) as call:
            for browser, sid, tid in [('a', 'chat1', '1'), ('b', 'chat1', '1'),
                                       ('a', 'chat2', '1'), ('a', 'chat1', '2')]:
                await server.call(context(sid, tid), 'tab_open', {}, browser)
            call.reset_mock()
            await server.turn_ended('chat1', '1')
            self.assertEqual(call.await_count, 2)
            self.assertEqual({c.args[2] for c in call.await_args_list}, {'a', 'b'})
            self.assertEqual(server._seen_contexts, {('a', 'chat2', '1'), ('a', 'chat1', '2')})
            await server.turn_ended('chat1', '1')
            self.assertEqual(call.await_count, 2)

    async def test_failed_profile_keeps_cleanup_pending_but_other_profile_finishes(self):
        server._seen_contexts.update({('a', 's', 't'), ('b', 's', 't')})
        async def end(action, args, browser, port):
            if browser == 'a':
                raise RuntimeError('disconnected')
        with patch.object(server, 'browser_call', side_effect=end):
            with self.assertRaisesRegex(RuntimeError, '1 connection'):
                await server.turn_ended('s', 't')
        self.assertEqual(server._seen_contexts, {('a', 's', 't')})
        with patch.object(server, 'browser_call', new_callable=AsyncMock):
            await server.turn_ended('s', 't')
        self.assertFalse(server._seen_contexts)

    async def test_default_profile_is_resolved_before_recording_cleanup(self):
        with patch.object(server, 'require_existing_connection', new_callable=AsyncMock, return_value={'id': 'real-profile'}), \
             patch.object(server, 'browser_call', new_callable=AsyncMock) as call:
            await server.call(context('s', 't'), 'tab_open', {}, None)
            await server.turn_ended('s', 't')
            self.assertEqual(call.await_args.args[2], 'real-profile')

    async def test_persistent_server_cleans_100_turns_without_exiting(self):
        with patch.object(server, 'browser_call', new_callable=AsyncMock) as call:
            for turn in range(100):
                await server.call(context('s', str(turn)), 'tab_open', {}, 'a')
                await server.turn_ended('s', str(turn))
                self.assertFalse(server._seen_contexts)
            self.assertEqual(call.await_count, 200)

    async def test_failed_host_cleanup_retries_even_while_owner_process_is_alive(self):
        bridge = Bridge(0)
        now = [0]
        bridge.owners = SessionOwners(clock=lambda: now[0], alive=lambda _: True)
        cleanup = AsyncMock()
        try:
            with self.assertRaisesRegex(RuntimeError, 'offline'):
                await bridge.owned_call(('browser', 'a'), {'session_id': 's', 'turn_id': 't'},
                    ('process', 100, 'owner'), cleanup, AsyncMock(side_effect=RuntimeError('offline')), ending=True)
            lease = next(iter(bridge.owners.leases.values()))
            self.assertTrue(lease.closing)
            self.assertEqual(lease.error, 'offline')
            now[0] = 16
            await bridge.owners.sweep()
            cleanup.assert_awaited_once()
            self.assertFalse(bridge.owners.leases)
        finally:
            await bridge.owners.close()
