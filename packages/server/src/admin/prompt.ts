import type { Readable, Writable } from 'node:stream';

export interface SecretIo {
  input: Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
  output: Writable;
}

/**
 * Reads a secret without echo. On a TTY: hidden prompt (raw mode). Otherwise (pipe/redirect):
 * the first line of stdin. Never reads argv or the environment.
 */
export async function readSecret(prompt: string, io: SecretIo): Promise<string> {
  if (io.input.isTTY && io.input.setRawMode) return readHidden(prompt, io);
  const chunks: Buffer[] = [];
  for await (const chunk of io.input) chunks.push(Buffer.from(chunk as Uint8Array));
  const text = Buffer.concat(chunks).toString('utf8');
  return (text.split(/\r?\n/, 1)[0] ?? '').replace(/\r$/, '');
}

function readHidden(prompt: string, { input, output }: SecretIo): Promise<string> {
  return new Promise((resolve, reject) => {
    output.write(prompt);
    let value = '';
    const finish = (error?: Error) => {
      input.setRawMode?.(false);
      input.pause();
      input.removeListener('data', onData);
      output.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (buffer: Buffer) => {
      for (const char of buffer.toString('utf8')) {
        if (char === '\r' || char === '\n' || char === '\u0004') return finish();
        if (char === '\u0003') return finish(new Error('Aborted.'));
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    input.setRawMode?.(true);
    input.resume();
    input.on('data', onData);
  });
}
