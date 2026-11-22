/** Build a complete ustar fixture with regular files, checksums, padding, and termination. */
export function tarOf(files: Record<string, string>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name, 0, "latin1");
    header.write("0000644\0", 100, "ascii");
    header.write("0000000\0", 108, "ascii");
    header.write("0000000\0", 116, "ascii");
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, "latin1");
    header.write("00000000000\0", 136, "ascii");
    header.fill(32, 148, 156);
    header.write("0", 156, "ascii");
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    parts.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}

/** Alpine secdb fixture with the published source identity fields. */
export function secdbFixture(
  branch: string,
  repository: "main" | "community",
  packages: unknown[] = [],
): Buffer {
  return Buffer.from(JSON.stringify({ distroversion: branch, reponame: repository, packages }));
}

/** Fixture for the publisher's root directory listing. */
export function secdbIndexFixture(...names: string[]): Buffer {
  const links = names.map((name) => `<a href="${name}/">${name}/</a>`).join("\r\n");
  return Buffer.from(
    "<html>\r\n<head><title>Index of /</title></head>\r\n<body>\r\n" +
      "<h1>Index of /</h1><hr><pre>" +
      links +
      "\r\n</pre><hr></body>\r\n</html>\r\n",
  );
}
