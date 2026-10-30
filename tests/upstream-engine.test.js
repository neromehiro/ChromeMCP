import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {AX,loadAX} from '../upstream/browser-engine.mjs';

await loadAX(new URL('../upstream/browser-accessibility.wasm.br',import.meta.url));

function fixture(){
  const frame={id:'frame',loaderId:'document',url:'https://example.test/'};
  const nodes=[
    {nodeId:'1',backendDOMNodeId:1,frameId:'frame',ignored:false,role:{value:'RootWebArea'},name:{value:'Test'},childIds:['2','3']},
    {nodeId:'2',backendDOMNodeId:2,ignored:false,role:{value:'button'},name:{value:'実行'},parentId:'1',properties:[]},
    {nodeId:'3',backendDOMNodeId:3,ignored:false,role:{value:'textbox'},name:{value:'比較入力'},parentId:'1',properties:[{name:'editable',value:{value:'plaintext'}}]},
  ];
  const dom={strings:['frame','BODY','BUTTON','INPUT','id','entry','type','text'],documents:[{
    frameId:0,nodes:{backendNodeId:[1,2,3],nodeName:[1,2,3],parentIndex:[-1,0,0],attributes:[[],[],[4,5,6,7]]},
    layout:{nodeIndex:[0,1,2],bounds:[[0,0,800,600],[10,10,100,40],[10,60,100,40]]},
  }]};
  const cdp=new EventEmitter();
  cdp.getJsDialog=()=>undefined;
  cdp.addTabCleanupHandler=()=>()=>{};
  cdp.readDocumentState=async()=>({href:frame.url,readyState:'complete',painted:true});
  cdp.callTarget=async(target,method)=>{
    if(method==='Page.getFrameTree')return {frameTree:{frame}};
    if(method==='DOMSnapshot.captureSnapshot')return dom;
    if(method==='Accessibility.getFullAXTree')return {nodes};
    return {};
  };
  cdp.call=async(id,method,args)=>cdp.callTarget({tabId:id},method,args);
  const ax=new AX(cdp,()=> 'session',{perform:async()=>{}},{getTab:async()=>({id:7,title:'Test',url:frame.url,active:true})});
  return {ax,frame,nodes,cdp};
}

test('unchanged upstream AX/WASM renders Chrome roles and maps IDs to backend nodes',async()=>{
  const {ax}=fixture();
  const capture=await ax.capture(7,'axState',{disableDiffing:true});
  assert.match(capture.state,/button 実行/);
  assert.match(capture.state,/比較入力/);
  const line=capture.state.split('\n').find(line=>line.includes('button 実行'));
  const index=Number(line.match(/^\s*(\d+)/)[1]);
  assert.equal(ax.targetForElement(7,index).backendNodeId,2);
  ax.validateCapture(7,capture);ax.dispose();
});

test('upstream AX rejects actions from an earlier navigation',async()=>{
  const {ax,frame,cdp}=fixture();
  const capture=await ax.capture(7,'axState',{disableDiffing:true});
  const index=Number(capture.state.split('\n').find(line=>line.includes('button 実行')).match(/^\s*(\d+)/)[1]);
  cdp.emit('event',{source:{tabId:7},method:'Page.frameNavigated',params:{frame:{...frame,loaderId:'next-document',url:'https://example.test/next'}}});
  assert.throws(()=>ax.targetForElement(7,index),/previous page|stale|missing/);
  assert.throws(()=>ax.validateCapture(7,capture),/previous page/);ax.dispose();
});
