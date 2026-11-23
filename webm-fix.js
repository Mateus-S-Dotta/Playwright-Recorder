// Torna navegável (dá para pular para qualquer minuto) o WebM gravado pelo MediaRecorder.
//
// O MediaRecorder grava "ao vivo": o arquivo sai sem a duração e sem o índice (Cues) que os
// players usam para pular no tempo. Esta função relê o arquivo e monta um novo com:
//   - Duration dentro de Info;
//   - Cues: um ponto de acesso por quadro-chave do vídeo (no máximo 1 por segundo);
//   - SeekHead apontando para Info, Tracks e Cues;
//   - tamanhos conhecidos no Segment e nos Clusters.
// O áudio e o vídeo (os Clusters) não são recodificados nem copiados para a memória: o Blob
// final referencia pedaços do original, então funciona com arquivos de vários GB.
//
// Uso: const navegavel = await fixWebm(blob)  (lança erro se o arquivo não tiver o formato esperado)
(() => {
  const ID = {
    EBML: 0x1A45DFA3, Segment: 0x18538067,
    SeekHead: 0x114D9B74, Seek: 0x4DBB, SeekID: 0x53AB, SeekPosition: 0x53AC,
    Info: 0x1549A966, TimecodeScale: 0x2AD7B1, Duration: 0x4489,
    Tracks: 0x1654AE6B, TrackEntry: 0xAE, TrackNumber: 0xD7, TrackType: 0x83,
    CodecID: 0x86,
    Cluster: 0x1F43B675, Timecode: 0xE7, SimpleBlock: 0xA3, BlockGroup: 0xA0, Block: 0xA1, ReferenceBlock: 0xFB,
    Cues: 0x1C53BB6B, CuePoint: 0xBB, CueTime: 0xB3, CueTrackPositions: 0xB7, CueTrack: 0xF7,
    CueClusterPosition: 0xF1,
    Tags: 0x1254C367, Chapters: 0x1043A770, Attachments: 0x1941A469,
  };
  // elementos de nível 1: num Cluster de tamanho desconhecido, encontrar um deles = fim do Cluster
  const LEVEL1 = new Set([ID.SeekHead, ID.Info, ID.Tracks, ID.Cluster, ID.Cues, ID.Tags, ID.Chapters, ID.Attachments]);
  const WINDOW = 4 << 20; // lê o arquivo em janelas de 4 MB

  // ---------- leitura ----------

  /** Lê um Blob em janelas, sem carregar o arquivo inteiro na memória. */
  class Reader {
    constructor(blob) {
      this.blob = blob;
      this.size = blob.size;
      this.start = 0;
      this.buf = new Uint8Array(0);
    }
    async need(pos, len) {
      const end = Math.min(pos + len, this.size);
      if (pos >= this.start && end <= this.start + this.buf.length) return;
      const to = Math.min(this.size, pos + Math.max(len, WINDOW));
      this.buf = new Uint8Array(await this.blob.slice(pos, to).arrayBuffer());
      this.start = pos;
    }
    byte(pos) { return this.buf[pos - this.start]; }
    bytes(pos, len) { return this.buf.slice(pos - this.start, pos - this.start + len); }
  }

  /** Tamanho de um número EBML de comprimento variável pelo primeiro byte (0 = inválido). */
  function vintLength(first, max) {
    for (let len = 1; len <= max; len++) if (first & (0x80 >> (len - 1))) return len;
    return 0;
  }

  /** Lê o cabeçalho (ID + tamanho) do elemento em `pos`. size = null quando "desconhecido". */
  function parseHeader(byte, pos, limit) {
    if (pos >= limit) return null;
    const idLen = vintLength(byte(pos), 4);
    if (!idLen || pos + idLen >= limit) return null;
    let id = 0;
    for (let i = 0; i < idLen; i++) id = id * 256 + byte(pos + i);
    const sizePos = pos + idLen;
    const s0 = byte(sizePos);
    const sizeLen = vintLength(s0, 8);
    if (!sizeLen || sizePos + sizeLen > limit) return null;
    const mask = 0xFF >> sizeLen;
    let size = s0 & mask;
    let unknown = size === mask;
    for (let i = 1; i < sizeLen; i++) {
      const b = byte(sizePos + i);
      size = size * 256 + b;
      if (b !== 0xFF) unknown = false;
    }
    return { id, pos, sizePos, sizeLen, data: sizePos + sizeLen, size: unknown ? null : size };
  }

  async function header(r, pos) {
    if (pos >= r.size) return null;
    await r.need(pos, 12);
    return parseHeader((i) => r.byte(i), pos, r.size);
  }

  /** Filhos de um elemento já carregado na memória. */
  function* children(bytes, from = 0, to = bytes.length) {
    let pos = from;
    while (pos < to) {
      const el = parseHeader((i) => bytes[i], pos, to);
      if (!el || el.size == null || el.data + el.size > to) return;
      yield { ...el, end: el.data + el.size };
      pos = el.data + el.size;
    }
  }

  function uintFrom(bytes, from, len) {
    let n = 0;
    for (let i = 0; i < len; i++) n = n * 256 + bytes[from + i];
    return n;
  }

  // ---------- escrita ----------

  function concat(...parts) {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let pos = 0;
    for (const p of parts) { out.set(p, pos); pos += p.length; }
    return out;
  }

  function idBytes(id) {
    const out = [];
    for (; id > 0; id = Math.floor(id / 256)) out.unshift(id % 256);
    return Uint8Array.from(out);
  }

  /** Inteiro sem sinal em `len` bytes (big-endian). */
  function uint(n, len = 8) {
    const out = new Uint8Array(len);
    for (let i = len - 1; i >= 0; i--, n = Math.floor(n / 256)) out[i] = n % 256;
    return out;
  }

  /** Tamanho EBML sempre com 8 bytes: o layout fica previsível antes de saber as posições. */
  function size8(n) {
    const out = uint(n, 8);
    out[0] = 0x01;
    return out;
  }

  function float64(x) {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setFloat64(0, x);
    return out;
  }

  function element(id, ...payload) {
    const data = concat(...payload);
    return concat(idBytes(id), size8(data.length), data);
  }

  // ---------- correção ----------

  async function fixWebm(blob) {
    const r = new Reader(blob);
    const ebml = await header(r, 0);
    if (!ebml || ebml.id !== ID.EBML || ebml.size == null) throw new Error('não é um arquivo WebM');
    const seg = await header(r, ebml.data + ebml.size);
    if (!seg || seg.id !== ID.Segment) throw new Error('WebM sem Segment');
    const segEnd = seg.size == null ? r.size : Math.min(r.size, seg.data + seg.size);

    let info = null;
    let tracks = null;
    const tags = [];
    const clusters = [];
    const cues = [];
    let scale = 1e6; // TimecodeScale padrão: 1 ms
    let videoTrack = null;
    let videoCodec = '';
    let maxTime = 0;
    let lastCue = -Infinity;

    /** Lê o início de um Block/SimpleBlock: trilha, tempo relativo, flags e 1º byte do quadro. */
    const readBlock = async (at) => {
      await r.need(at, 16);
      const tl = vintLength(r.byte(at), 8);
      let track = r.byte(at) & (0xFF >> tl);
      for (let i = 1; i < tl; i++) track = track * 256 + r.byte(at + i);
      const rel = ((r.byte(at + tl) << 8) | r.byte(at + tl + 1)) << 16 >> 16;
      return { track, rel, flags: r.byte(at + tl + 2), first: r.byte(at + tl + 3) };
    };
    /** Quadro-chave pelo cabeçalho do próprio codec (BlockGroup não tem a flag de keyframe). */
    const codecKeyframe = (first) =>
      videoCodec === 'V_VP8' ? (first & 0x01) === 0       // VP8: bit 0 do frame tag = 0
      : videoCodec === 'V_VP9' ? (first & 0x0C) === 0     // VP9: show_existing_frame = 0 e frame_type = 0
      : true;
    const addBlock = (time, b, keyframe) => {
      const t = time + b.rel;
      if (t > maxTime) maxTime = t;
      if (keyframe && (videoTrack == null || b.track === videoTrack) && t - lastCue >= 1e9 / scale) {
        cues.push({ time: t, track: b.track, cluster: clusters.length });
        lastCue = t;
      }
    };

    const readRaw = async (el) => {
      await r.need(el.pos, el.data + el.size - el.pos);
      return r.bytes(el.pos, el.data + el.size - el.pos);
    };

    let pos = seg.data;
    while (pos < segEnd) {
      const el = await header(r, pos);
      if (!el) break;

      if (el.id === ID.Cluster) {
        const limit = el.size == null ? segEnd : Math.min(segEnd, el.data + el.size);
        let time = 0;
        let p = el.data;
        while (p < limit) {
          const ch = await header(r, p);
          if (!ch) { p = limit; break; }
          if (el.size == null && LEVEL1.has(ch.id)) break;
          if (ch.size == null) throw new Error('bloco de tamanho desconhecido dentro do Cluster');
          const chEnd = ch.data + ch.size;
          if (chEnd > limit) break; // arquivo terminou no meio do bloco: descarta o pedaço
          if (ch.id === ID.Timecode) {
            await r.need(ch.data, ch.size);
            time = uintFrom(r.buf, ch.data - r.start, ch.size);
          } else if (ch.id === ID.SimpleBlock) {
            const b = await readBlock(ch.data);
            addBlock(time, b, (b.flags & 0x80) !== 0);
          } else if (ch.id === ID.BlockGroup) {
            // usado quando o quadro tem dados extras (ex.: transparência)
            let b = null;
            let referenced = false;
            for (let q = ch.data; q < chEnd;) {
              const sub = await header(r, q);
              if (!sub || sub.size == null) break;
              if (sub.id === ID.Block) b = await readBlock(sub.data);
              if (sub.id === ID.ReferenceBlock) referenced = true;
              q = sub.data + sub.size;
            }
            if (b) addBlock(time, b, !referenced && (b.track !== videoTrack || codecKeyframe(b.first)));
          }
          p = chEnd;
        }
        clusters.push({ ...el, end: p });
        pos = p;
        continue;
      }

      if (el.size == null || el.data + el.size > segEnd) break;
      if (el.id === ID.Info) {
        info = await readRaw(el);
        for (const ch of children(info, el.data - el.pos)) {
          if (ch.id === ID.TimecodeScale) scale = uintFrom(info, ch.data, ch.size);
        }
      } else if (el.id === ID.Tracks) {
        tracks = await readRaw(el);
        for (const entry of children(tracks, el.data - el.pos)) {
          if (entry.id !== ID.TrackEntry) continue;
          let type = 0, number = 0, codec = '';
          for (const f of children(tracks, entry.data, entry.end)) {
            if (f.id === ID.TrackType) type = uintFrom(tracks, f.data, f.size);
            if (f.id === ID.TrackNumber) number = uintFrom(tracks, f.data, f.size);
            if (f.id === ID.CodecID) codec = String.fromCharCode(...tracks.subarray(f.data, f.data + f.size));
          }
          if (type === 1 && videoTrack == null) { videoTrack = number; videoCodec = codec; }
        }
      } else if (el.id === ID.Tags) {
        tags.push(await readRaw(el));
      }
      // SeekHead, Cues e Void antigos são descartados: serão refeitos
      pos = el.data + el.size;
    }

    if (!info || !tracks || !clusters.length || !cues.length) {
      throw new Error(`estrutura WebM inesperada (info=${!!info} tracks=${!!tracks} clusters=${clusters.length} cues=${cues.length})`);
    }

    // Info sem a Duration antiga (se houver) + Duration nova
    const infoHeader = parseHeader((i) => info[i], 0, info.length);
    const infoKeep = [...children(info, infoHeader.data)]
      .filter((ch) => ch.id !== ID.Duration)
      .map((ch) => info.subarray(ch.pos, ch.end));
    const infoOut = element(ID.Info, ...infoKeep, element(ID.Duration, float64(maxTime)));

    const seekHead = (pInfo, pTracks, pCues) => element(ID.SeekHead,
      element(ID.Seek, element(ID.SeekID, idBytes(ID.Info)), element(ID.SeekPosition, uint(pInfo))),
      element(ID.Seek, element(ID.SeekID, idBytes(ID.Tracks)), element(ID.SeekPosition, uint(pTracks))),
      element(ID.Seek, element(ID.SeekID, idBytes(ID.Cues)), element(ID.SeekPosition, uint(pCues))));
    const cuePoint = (c, clusterPos) => element(ID.CuePoint,
      element(ID.CueTime, uint(c.time)),
      element(ID.CueTrackPositions, element(ID.CueTrack, uint(c.track)), element(ID.CueClusterPosition, uint(clusterPos))));

    // todos os campos têm tamanho fixo, então dá para calcular as posições antes de montar
    const seekLen = seekHead(0, 0, 0).length;
    const tagsLen = tags.reduce((n, t) => n + t.length, 0);
    const cuesLen = idBytes(ID.Cues).length + 8 + cues.length * cuePoint(cues[0], 0).length;
    const pInfo = seekLen;
    const pTracks = pInfo + infoOut.length;
    const pCues = pTracks + tracks.length + tagsLen;
    let clusterPos = pCues + cuesLen;

    const clusterParts = [];
    const clusterStart = [];
    for (const c of clusters) {
      clusterStart.push(clusterPos);
      if (c.size == null && c.sizeLen === 8) {
        // troca o tamanho "desconhecido" pelo real, no mesmo espaço de 8 bytes
        clusterParts.push(idBytes(ID.Cluster), size8(c.end - c.data), blob.slice(c.data, c.end));
      } else {
        clusterParts.push(blob.slice(c.pos, c.end));
      }
      clusterPos += c.end - c.pos;
    }

    const cuesOut = element(ID.Cues, ...cues.map((c) => cuePoint(c, clusterStart[c.cluster])));
    const segmentData = [seekHead(pInfo, pTracks, pCues), infoOut, tracks, ...tags, cuesOut];
    return new Blob([
      blob.slice(0, ebml.data + ebml.size),
      idBytes(ID.Segment), size8(clusterPos),
      ...segmentData,
      ...clusterParts,
    ], { type: blob.type || 'video/webm' });
  }

  globalThis.fixWebm = fixWebm;
})();
