import { gzipSync } from "node:zlib";

export type Entry = { path: string; body?: string; dir?: boolean };

function block(entry: Entry): Buffer {
  const body = Buffer.from(entry.body ?? "");
  const header = Buffer.alloc(512);
  header.write(entry.path, 0, "utf8");
  header.write("0000644\0", 100, "latin1");
  header.write("0000000\0", 108, "latin1");
  header.write("0000000\0", 116, "latin1");
  header.write(body.length.toString(8).padStart(11, "0") + "\0", 124, "latin1");
  header.write("00000000000\0", 136, "latin1");
  header.write(entry.dir ? "5" : "0", 156, "latin1");
  header.write("ustar\0" + "00", 257, "latin1");
  header.write("        ", 148, "latin1");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
  return Buffer.concat([header, body, padding]);
}

export function archive(entries: Entry[]): Buffer {
  const tar = Buffer.concat([...entries.map(block), Buffer.alloc(1024)]);
  return gzipSync(tar);
}
