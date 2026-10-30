import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalConfig} from '../upstream/local-config.mjs';

test('standalone configuration keeps policy and separate session preferences',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'chrome-config-')),path=join(dir,'policy.json');
  try{
    const scopes=new Map();
    const host={readToml:async key=>scopes.get(key)||{},writeToml:async(key,value)=>scopes.set(key,value)};
    const config=new LocalConfig(path,host);
    assert.deepEqual(await config.read(),{config:{}});
    assert.deepEqual(await config.readToml('browser.toml'),{disable_auto_review:true});
    const policy={config:{browser_use:{allow_history_access:false}},requirements:{network:{deniedDomains:['blocked.test']}}};
    await writeFile(path,JSON.stringify(policy));
    assert.deepEqual(await config.readRequirements(),{requirements:policy.requirements});
    await Promise.all(['one','two'].map(id=>new LocalConfig(path,host).writeToml(`browser/sessions/${id}.toml`,{name:id})));
    assert.deepEqual(await config.readToml('browser/sessions/one.toml'),{name:'one'});
    assert.deepEqual(await config.readToml('browser/sessions/two.toml'),{name:'two'});
    assert.deepEqual(JSON.parse(await readFile(path,'utf8')),policy);
    await writeFile(path,'broken');
    await assert.rejects(config.read());
    await writeFile(path,'{"requirements":null}');
    await assert.rejects(config.readRequirements(),/Invalid local/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
