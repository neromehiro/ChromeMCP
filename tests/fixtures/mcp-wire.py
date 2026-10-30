#!/usr/bin/env python3
"""Protocol fixture: nested server requests reuse a client's request ID."""
import json,sys
pending=None
for line in sys.stdin:
 m=json.loads(line)
 if m.get('method')=='tools/call':
  p=m['params']
  if p['name']=='js_reset':
   pending=m['id'];out={'jsonrpc':'2.0','id':pending,'method':'elicitation/create','params':{'message':'Fixture form','requestedSchema':{'type':'object','properties':{}}}}
  else:
   out={'jsonrpc':'2.0','id':m['id'],'result':{'content':[{'type':'text','text':'raw result'},{'type':'image','mimeType':'image/png','data':'AA=='}],'_meta':{'original':True},'structuredContent':p}}
 elif 'result' in m and pending is not None:
  out={'jsonrpc':'2.0','id':pending,'result':{'content':[],'_meta':{'originalReset':True}}};pending=None
 else:out={'jsonrpc':'2.0','method':'notifications/progress','params':m}
 print(json.dumps(out,separators=(',',':')),flush=True)
