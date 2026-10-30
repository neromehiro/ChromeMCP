"""Expose installed upstream engines without changing their operation code.

The extension startup is replaced by our loopback transport. The service's
private engine classes are exported; its app-host startup is never invoked.
"""
from pathlib import Path
import hashlib
import json
import shutil

root = Path(__file__).resolve().parent
source = root / 'comparison/original-1.26.901.11451'
out = root / 'upstream'
out.mkdir(exist_ok=True)
extension = (source / 'background.readable.js').read_text()
assert extension.count('var background = (function () {') == 1
assert extension.count('((Pi = Xm.main()),') == 1
assert extension.count('return e_;') == 1
extension = extension.replace('var background = (function () {', 'export const upstream = (function () {',1)
extension = extension.replace('((Pi = Xm.main()),', '((Pi = undefined),',1)
extension = extension.replace('return e_;','return {BrowserBackend: Kf, BrowserRpcBridge: cl, BrowserTabMentionProvider: fs, tabFavicons: () => zn.getInstance(), featureGate: Nr, webMcpConfig: Om, observeTabMentionInvalidations: wf, handlePageMessage: Km, isAgentBackgroundPopup: yh, isPageEvent: ml, tabLeases: () => Le.getInstance(), debuggerAttachedTabs: () => [...Je]};',1)
(out / 'extension-core.js').write_text(extension)
restored_runtime=source/'runtime/raw'
shutil.copy2(restored_runtime/'browser-service.mjs',out/'browser-service.raw.mjs')
service = (out / 'browser-service.raw.mjs').read_text()
# The ambient-network-off mode skips account/Statsig initialization, but the
# original header feature reader still demands it. Keep the original extension's
# explicit enabled header flag; only default this optional account flag to false.
header_entry='async function C_(){'
assert service.count(header_entry)==1
local_service=service.replace(header_entry,header_entry+'if(dn(TF()))return!1;',1)
# Keep the original directory scan and refresh logic; only select our transport
# directory instead of the App's. This also allows backends to connect later.
directory_entry='Mte=async t=>{let e=Ka(t.platform);'
assert local_service.count(directory_entry)==1
local_service=local_service.replace(directory_entry,'Mte=async t=>{let e=t.env.BROWSER_USE_BACKEND_DIRECTORY??Ka(t.platform);',1)
config_entry='function uF(t){'
assert local_service.count(config_entry)==1
local_service=local_service.replace(config_entry,config_entry+'if(t.env.LOCAL_CHROME_POLICY_PATH)t={...t,config:new LocalBridgeConfig(t.env.LOCAL_CHROME_POLICY_PATH,t.config)};',1)
local_service="import {LocalConfig as LocalBridgeConfig} from './local-config.mjs';\n"+local_service
(out/'browser-service.local.mjs').write_text(local_service)
exports = '\nexport { gf as Cdp, Tf as AX, xf as AXActions, qf as Input, Nf as Playwright, Kf as Cursor, FO as loadAX, oh as Clipboard, ch as BrowserServiceController, bh as BrowserSessionClient, wh as TurnEndedTracker, tF as setupService, uF as ConfigProvider, r3 as HostFilesystem, EF as CommandTiming, RF as PerformanceSpan, ae as CommandSchemas, Bte as configureBrowserInfo, Kl as clickLocator, N_ as fillLocator, Zl as pressLocator, nO as selectOption, oO as setChecked, aO as waitLocator, VB as domSnapshot, Zp as screenshot };\n'
exports += '\nexport { xh as OriginalBrowserContext, OC as browserPreference, hF as enrichProfileInfo, n3 as OriginalBrowserRpcService, Bi as BrowserCredentialRecoveryError };\n'
(out / 'browser-engine.mjs').write_text(service + exports)
shutil.copy2(restored_runtime/'browser-client.mjs',out/'browser-client.mjs')
wasm = restored_runtime/'browser-accessibility.wasm.br'
shutil.copy2(wasm, out / wasm.name)
for name in ['codex.js','foreign-frame-monitor.js']:
    target=root/'content-scripts'/name;target.parent.mkdir(exist_ok=True)
    shutil.copy2(source/'raw/content-scripts'/name,target)
for name in ['cursor-chat.png','icon128.png']:
    target=root/'images'/name;target.parent.mkdir(exist_ok=True)
    shutil.copy2(source/'raw/images'/name,target)
records={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [source/'raw/background.js',out/'browser-service.raw.mjs',out/'browser-accessibility.wasm.br']}
(out/'provenance.json').write_text(json.dumps({'upstream_version':'1.26.901.11451','inputs':records,'extension_changes':['export BrowserBackend and original bootstrap handlers','do not start the original Native Messaging/App/side panel bootstrap'],'service_changes':['append exports only to browser-engine.mjs; original class bodies unchanged'],'local_service_changes':['insert if(dn(TF()))return!1; at C_ to default the optional account flag when ambient networking is disabled','insert t.env.BROWSER_USE_BACKEND_DIRECTORY?? at Mte to use the local transport directory with the original discovery and refresh logic','uF uses LocalConfig only when LOCAL_CHROME_POLICY_PATH is explicitly selected; original policy evaluation is unchanged'],'wasm_changes':[]},ensure_ascii=False,indent=2))
print('Upstream extension, AX/WASM, input and Playwright engines prepared')
