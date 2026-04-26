/**
 * Tiny pure-JS ZIP writer. "Stored" mode only (no compression — fine for
 * small text artifacts like markdown + a few KB of HTML each). Avoids
 * pulling in jszip just for the export endpoint.
 *
 * Reference: PKWARE APPNOTE.TXT, sections on local file headers, central
 * directory records, and end of central directory.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (CRC_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** Path inside the archive (forward slashes). */
  path: string;
  /** UTF-8 text content. */
  content: string;
}

interface CentralRecord {
  path: string;
  pathBytes: Buffer;
  crc: number;
  size: number;
  offset: number;
}

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const END_OF_CENTRAL_SIG = 0x06054b50;
const VERSION = 20;

export function buildZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: CentralRecord[] = [];
  let offset = 0;

  for (const entry of entries) {
    const pathBytes = Buffer.from(entry.path, "utf8");
    const data = Buffer.from(entry.content, "utf8");
    const crc = crc32(data);
    const size = data.length;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_HEADER_SIG, 0);
    header.writeUInt16LE(VERSION, 4);
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(0, 8); // method = stored
    header.writeUInt16LE(0, 10); // mod time
    header.writeUInt16LE(0, 12); // mod date
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(size, 18); // compressed size
    header.writeUInt32LE(size, 22); // uncompressed size
    header.writeUInt16LE(pathBytes.length, 26);
    header.writeUInt16LE(0, 28); // extra field length

    parts.push(header, pathBytes, data);
    central.push({ path: entry.path, pathBytes, crc, size, offset });
    offset += header.length + pathBytes.length + data.length;
  }

  const centralStart = offset;
  for (const rec of central) {
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(CENTRAL_HEADER_SIG, 0);
    cdh.writeUInt16LE(VERSION, 4); // version made by
    cdh.writeUInt16LE(VERSION, 6); // version needed
    cdh.writeUInt16LE(0, 8); // flags
    cdh.writeUInt16LE(0, 10); // method
    cdh.writeUInt16LE(0, 12); // mod time
    cdh.writeUInt16LE(0, 14); // mod date
    cdh.writeUInt32LE(rec.crc, 16);
    cdh.writeUInt32LE(rec.size, 20);
    cdh.writeUInt32LE(rec.size, 24);
    cdh.writeUInt16LE(rec.pathBytes.length, 28);
    cdh.writeUInt16LE(0, 30); // extra
    cdh.writeUInt16LE(0, 32); // comment
    cdh.writeUInt16LE(0, 34); // disk number
    cdh.writeUInt16LE(0, 36); // internal attrs
    cdh.writeUInt32LE(0, 38); // external attrs
    cdh.writeUInt32LE(rec.offset, 42);

    parts.push(cdh, rec.pathBytes);
    offset += cdh.length + rec.pathBytes.length;
  }
  const centralSize = offset - centralStart;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(END_OF_CENTRAL_SIG, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk start
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20); // comment length
  parts.push(eocd);

  return Buffer.concat(parts);
}
