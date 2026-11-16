/* ZIP 읽기 — 파일 전체를 메모리에 올리지 않고 필요한 부분만 잘라 읽는다.
 * 지원: 저장(0)·deflate(8) 압축, ZIP64. 미지원: 암호화, 분할 ZIP.
 */
'use strict';

const ZipReader = (() => {
  const SIG_EOCD = 0x06054b50;
  const SIG_EOCD64_LOC = 0x07064b50;
  const SIG_EOCD64 = 0x06064b50;
  const SIG_CENTRAL = 0x02014b50;
  const SIG_LOCAL = 0x04034b50;
  const MAX_ENTRY = 64 * 1024 * 1024; // 팩 하나는 32MB 이하. 여유를 둔 상한.

  async function readBytes(file, start, end) {
    return new DataView(await file.slice(start, end).arrayBuffer());
  }

  const u64 = (view, at) => {
    const lo = view.getUint32(at, true);
    const hi = view.getUint32(at + 4, true);
    return hi * 0x100000000 + lo;
  };

  // 팩 이름은 영문·숫자뿐이라 인코딩 구분 없이 UTF-8로 읽어도 된다.
  const nameDecoder = new TextDecoder('utf-8');
  const decodeName = (bytes) => nameDecoder.decode(bytes);

  // 중앙 디렉터리를 읽어 항목 목록을 돌려준다.
  async function readIndex(file) {
    const tailLen = Math.min(file.size, 65557 + 20);
    const tailStart = file.size - tailLen;
    const tail = await readBytes(file, tailStart, file.size);
    let eocd = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--) {
      if (tail.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ZIP 파일이 아니거나 손상되었습니다.');

    let count = tail.getUint16(eocd + 10, true);
    let cdSize = tail.getUint32(eocd + 12, true);
    let cdOffset = tail.getUint32(eocd + 16, true);
    if (tail.getUint16(eocd + 4, true) !== 0 || tail.getUint16(eocd + 6, true) !== 0) {
      throw new Error('여러 조각으로 나뉜 ZIP은 지원하지 않습니다.');
    }

    // ZIP64
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const locAt = eocd - 20;
      if (locAt < 0 || tail.getUint32(locAt, true) !== SIG_EOCD64_LOC) throw new Error('ZIP64 정보를 찾지 못했습니다.');
      const eocd64Offset = u64(tail, locAt + 8);
      const z = await readBytes(file, eocd64Offset, eocd64Offset + 56);
      if (z.getUint32(0, true) !== SIG_EOCD64) throw new Error('ZIP64 정보가 손상되었습니다.');
      count = u64(z, 32);
      cdSize = u64(z, 40);
      cdOffset = u64(z, 48);
    }

    if (cdOffset + cdSize > file.size) throw new Error('ZIP 목차가 파일 범위를 벗어납니다. 파일이 덜 받아졌을 수 있습니다.');
    const cd = await readBytes(file, cdOffset, cdOffset + cdSize);
    const entries = [];
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (p + 46 > cd.byteLength || cd.getUint32(p, true) !== SIG_CENTRAL) throw new Error('ZIP 목차가 손상되었습니다.');
      const flags = cd.getUint16(p + 8, true);
      const method = cd.getUint16(p + 10, true);
      let compSize = cd.getUint32(p + 20, true);
      let size = cd.getUint32(p + 24, true);
      const nameLen = cd.getUint16(p + 28, true);
      const extraLen = cd.getUint16(p + 30, true);
      const commentLen = cd.getUint16(p + 32, true);
      let localOffset = cd.getUint32(p + 42, true);
      const nameBytes = new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen);
      const name = decodeName(nameBytes);

      // ZIP64 확장 필드
      let x = p + 46 + nameLen;
      const xEnd = x + extraLen;
      while (x + 4 <= xEnd) {
        const id = cd.getUint16(x, true);
        const len = cd.getUint16(x + 2, true);
        if (id === 0x0001) {
          let q = x + 4;
          if (size === 0xffffffff) { size = u64(cd, q); q += 8; }
          if (compSize === 0xffffffff) { compSize = u64(cd, q); q += 8; }
          if (localOffset === 0xffffffff) { localOffset = u64(cd, q); q += 8; }
        }
        x += 4 + len;
      }

      entries.push({ name, flags, method, compSize, size, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  // 항목 하나를 꺼내 Uint8Array로 돌려준다.
  async function extract(file, entry, signal) {
    if (entry.flags & 0x1) throw new Error('암호가 걸린 ZIP은 지원하지 않습니다.');
    if (entry.method !== 0 && entry.method !== 8) throw new Error('지원하지 않는 압축 방식입니다: ' + entry.method);
    if (entry.size > MAX_ENTRY || entry.compSize > MAX_ENTRY) throw new Error('항목이 너무 큽니다: ' + entry.name);

    const lh = await readBytes(file, entry.localOffset, entry.localOffset + 30);
    if (lh.getUint32(0, true) !== SIG_LOCAL) throw new Error('ZIP 항목 머리말이 손상되었습니다: ' + entry.name);
    const dataStart = entry.localOffset + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    const raw = file.slice(dataStart, dataStart + entry.compSize);

    if (entry.method === 0) {
      const buf = new Uint8Array(await raw.arrayBuffer());
      if (buf.byteLength !== entry.size) throw new Error('ZIP 항목 크기가 맞지 않습니다: ' + entry.name);
      return buf;
    }

    const out = new Uint8Array(entry.size);
    let filled = 0;
    const reader = raw.stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    try {
      for (;;) {
        if (signal?.aborted) throw new DOMException('취소됨', 'AbortError');
        const { done, value } = await reader.read();
        if (done) break;
        if (filled + value.byteLength > out.byteLength) throw new Error('압축을 푼 크기가 기록보다 큽니다: ' + entry.name);
        out.set(value, filled);
        filled += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    if (filled !== entry.size) throw new Error('압축을 푼 크기가 기록과 다릅니다: ' + entry.name);
    return out;
  }

  return { readIndex, extract };
})();
