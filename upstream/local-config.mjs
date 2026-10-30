// Host configuration boundary for non-Codex clients. Policy interpretation,
// consent and session preference caching remain in the original uF provider.
import {readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';

async function readObject(path,missing){
  let value;
  try{value=JSON.parse(await readFile(path,'utf8'));}
  catch(error){if(error.code==='ENOENT')return missing;throw error;}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Local browser configuration must be an object');
  return value;
}

export class LocalConfig {
  constructor(path,hostConfig){
    if(!isAbsolute(path))throw new Error('Local browser policy path must be absolute');
    this.path=path;
    this.hostConfig=hostConfig;
  }
  async policy(){
    const value=await readObject(this.path,{config:{},requirements:{},global:{},sessions:{}});
    for(const key of ['config','requirements','global','sessions']){
      if(value[key]!==undefined&&(!value[key]||typeof value[key]!=='object'||Array.isArray(value[key])))throw new Error('Invalid local browser configuration: '+key);
    }
    return value;
  }
  async read(){return {config:(await this.policy()).config||{}};}
  async readRequirements(){return {requirements:(await this.policy()).requirements||{}};}
  async readToml(key){
    const policy=await this.policy();
    // Standalone hosts use the original human-elicitation branch. They do not
    // provide Codex's Guardian auto-review service; no approval is fabricated.
    const fallback=key.includes('/sessions/')?policy.sessions?.[key]||{}:{disable_auto_review:true,...policy.global};
    return {...fallback,...await this.hostConfig.readToml(key)};
  }
  async writeToml(key,value){
    // The trusted worker is filesystem-read-only. Keep the original privileged
    // TOML storage API, with a dedicated standalone home selected by the launcher.
    await this.hostConfig.writeToml(key,value);
  }
}
