// A missing CDP event invalidates the stream: fail the entire connection visibly.
// Never silently drop an event and continue with a stale browser state.
// Match the existing 32 MiB frame limit, including large screenshot responses.
export const MAX_BUFFER_BYTES=32*1024*1024;
export function sendBounded(connection,value,onOverflow){
  if(connection.readyState!==1)return false;
  const text=JSON.stringify(value);
  if(connection.bufferedAmount+new TextEncoder().encode(text).byteLength>MAX_BUFFER_BYTES){
    onOverflow();
    connection.close(4008,'Bridge send buffer exceeded');
    return false;
  }
  connection.send(text);
  return true;
}
