"""A service stop drains original turn cleanup before closing native endpoints."""
import asyncio,json,signal,socket,sys,unittest,uuid
from pathlib import Path
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed
from chrome_bridge.protocol import ROOT,extension_id
from chrome_bridge.native_transport import native_directory

class DaemonShutdownTests(unittest.IsolatedAsyncioTestCase):
 async def test_sigterm_drains_original_cleanup_and_removes_live_native_socket(self):
  await self.check_shutdown(signal.SIGTERM)

 async def test_sigint_drains_original_cleanup_and_removes_live_native_socket(self):
  await self.check_shutdown(signal.SIGINT)

 async def check_shutdown(self, stop_signal):
  with socket.socket() as listener:
   listener.bind(('127.0.0.1',0));port=listener.getsockname()[1]
  process=await asyncio.create_subprocess_exec(sys.executable,'-m','chrome_bridge.cli','--port',str(port),'serve',cwd=ROOT,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.PIPE)
  extension=None;writer=None;responding=None;methods=[]
  instance=str(uuid.uuid4());path=native_directory(port)/(instance+'.sock')
  try:
   self.assertIn(b'Chrome bridge ready',await asyncio.wait_for(process.stdout.readline(),5))
   extension=await connect(f'ws://127.0.0.1:{port}/extension',origin='chrome-extension://'+extension_id())
   await extension.send(json.dumps({'type':'hello','protocol':1,'instance_id':instance,'version':'0.5.1','label':'shutdown fixture'}))
   self.assertEqual(json.loads(await extension.recv())['type'],'welcome')
   async def respond():
    try:
     async for raw in extension:
      message=json.loads(raw)
      if message.get('type')!='command':continue
      method=message['params']['method'];methods.append(method)
      await extension.send(json.dumps({'type':'response','id':message['id'],'result':[] if method=='getTabs' else {}}))
    except ConnectionClosed:pass
   responding=asyncio.create_task(respond())
   reader,writer=await asyncio.open_unix_connection(path)
   body=json.dumps({'jsonrpc':'2.0','id':1,'method':'getTabs','params':{'session_id':'shutdown-test','turn_id':'one'}}).encode()
   writer.write(len(body).to_bytes(4,sys.byteorder)+body);await writer.drain()
   size=int.from_bytes(await reader.readexactly(4),sys.byteorder)
   self.assertIn('result',json.loads(await reader.readexactly(size)))
   process.send_signal(stop_signal)
   await asyncio.wait_for(process.wait(),5)
   self.assertEqual(methods,['getTabs','turnEnded'],'Service stop must invoke the existing original cleanup')
   self.assertEqual(await asyncio.wait_for(reader.read(),2),b'')
   self.assertFalse(path.exists(),'No dead backend socket may remain discoverable')
   self.assertEqual(process.returncode,0)
  finally:
   if writer:writer.close();await writer.wait_closed()
   if extension:await extension.close()
   if responding:await responding
   if process.returncode is None:process.kill();await process.wait()
   path.unlink(missing_ok=True)
