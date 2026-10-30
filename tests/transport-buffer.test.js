import test from 'node:test';
import assert from 'node:assert/strict';
import {sendBounded,MAX_BUFFER_BYTES} from '../transport-buffer.js';

test('stalled CDP stream is bounded and explicitly disconnected',()=>{
  const sent=[];let overflow=0;
  const socket={readyState:1,bufferedAmount:0,send(text){sent.push(text);this.bufferedAmount+=Buffer.byteLength(text);},close(code){this.code=code;this.readyState=3;}};
  for(let n=0;n<20000;n++)sendBounded(socket,{event:'CDP',text:'あ'.repeat(1024)},()=>overflow++);
  assert.ok(socket.bufferedAmount<=MAX_BUFFER_BYTES);
  assert.equal(overflow,1);
  assert.equal(socket.code,4008);
  assert.ok(sent.length>0&&sent.length<20000);
});

test('healthy stream preserves every response and event',()=>{
  const sent=[];
  const socket={readyState:1,bufferedAmount:0,send:x=>sent.push(JSON.parse(x))};
  for(let id=0;id<100;id++)assert.equal(sendBounded(socket,{id},()=>assert.fail()),true);
  assert.deepEqual(sent,Array.from({length:100},(_,id)=>({id})));
});

test('large screenshot within the existing frame limit is preserved',()=>{
  let size=0;
  const socket={readyState:1,bufferedAmount:0,send:x=>{size=Buffer.byteLength(x);}};
  assert.equal(sendBounded(socket,{screenshot:'a'.repeat(10*1024*1024)},()=>assert.fail()),true);
  assert.ok(size>10*1024*1024&&size<MAX_BUFFER_BYTES);
});
