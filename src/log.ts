// One JSON line per event on stdout; Render's log view and search read it as is.
export type Log = (event: string, fields?: Record<string, unknown>) => void;

export function makeLog(service: string, write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Log {
  return (event, fields = {}) => write(JSON.stringify({ t: new Date().toISOString(), service, event, ...fields }));
}
