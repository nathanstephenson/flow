import { deserialize, serialize } from "node:v8";

export function encodeFrame(message: unknown): Buffer {
  const body = serialize(message);
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

export function frameDecoder(onMessage: (message: unknown) => void): (chunk: Buffer) => void {
  let chunks: Buffer[] = [];
  let size = 0;
  let need = 4;
  let header = true;
  return (chunk) => {
    chunks.push(chunk);
    size += chunk.length;
    while (size >= need) {
      const data = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, size);
      chunks = [data];
      if (header) {
        need = 4 + data.readUInt32BE(0);
        header = false;
        continue;
      }
      const message = deserialize(data.subarray(4, need));
      const rest = data.subarray(need);
      chunks = rest.length ? [rest] : [];
      size = rest.length;
      need = 4;
      header = true;
      onMessage(message);
    }
  };
}
