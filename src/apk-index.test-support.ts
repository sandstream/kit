/** A minimal tar stream of named files, for APKINDEX tests; the parser reads only name and size. */
export function tarOf(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name, 0, "latin1");
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, "latin1");
    parts.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}
