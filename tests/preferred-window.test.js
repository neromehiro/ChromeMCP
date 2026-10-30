import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalHost} from '../upstream/local-host.mjs';

test('compat window_id reaches original createTab before creation, across cached controller and concurrent sessions',async()=>{
  const creates=[];let id=1,host;
  host=new LocalHost(message=>{
    let result={};
    if(message.method==='getInfo')result={type:'extension',family:'chrome',name:'Fixture'};
    if(message.method==='getTabs')result=[];
    if(message.method==='createTab'){
      creates.push(message.arguments);
      creates.at(-1).session=message.session_id;
      result={id:id++,url:'about:blank',active:true};
    }
    setTimeout(()=>host.result({id:message.id,result}),1);
  });
  await host.setup();
  const command=(session,window_id,type='create_tab')=>host.withContext('fixture',{
    session_id:session,turn_id:'turn',...(window_id===undefined?{}:{window_id}),
  },()=>host.execute({type,browser_id:'fixture',...(type==='name_session'?{name:'Fixture'}:{})}));
  // A prior command has already cached the original service controller.
  await command('a',undefined,'name_session');
  await command('a',2);
  await Promise.all([command('b',3),command('c',4)]);
  await command('d',undefined);
  assert.deepEqual(creates.map(x=>[x.session,x.preferredWindowId]),[['a',2],['b',3],['c',4],['d',undefined]]);
});
