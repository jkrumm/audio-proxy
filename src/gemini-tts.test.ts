import { describe, expect, test } from "bun:test";
import { parsePrepResponse, pcmToWav } from "./gemini-tts-core";

describe("pcmToWav", () => {
  test("writes a valid 44-byte WAV header for mono 16-bit 24kHz", () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const buf = pcmToWav(pcm, 24000);
    const view = new DataView(buf);
    const str = (off: number, len: number): string =>
      String.fromCharCode(...new Uint8Array(buf, off, len));

    expect(buf.byteLength).toBe(44 + pcm.byteLength);
    expect(str(0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + pcm.byteLength);
    expect(str(8, 4)).toBe("WAVE");
    expect(str(12, 4)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16); // PCM subchunk size
    expect(view.getUint16(20, true)).toBe(1); // audio format = PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(24000); // sample rate
    expect(view.getUint32(28, true)).toBe(24000 * 2); // byte rate = rate * blockAlign
    expect(view.getUint16(32, true)).toBe(2); // block align = channels * bytes/sample
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    expect(str(36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(pcm.byteLength);
    expect(new Uint8Array(buf, 44)).toEqual(pcm);
  });
});

describe("parsePrepResponse", () => {
  test("parses strict JSON", () => {
    const out = parsePrepResponse(
      '{"lang":"de","chunks":[{"style":"Lies ruhig","text":"Heute drei Termine."}]}',
    );
    expect(out.lang).toBe("de");
    expect(out.chunks).toHaveLength(1);
    expect(out.chunks[0]).toEqual({ style: "Lies ruhig", text: "Heute drei Termine." });
  });

  test("tolerates markdown fences and surrounding prose", () => {
    const raw = 'Here you go:\n```json\n{"lang":"en","chunks":[{"style":"Warm","text":"[pause] Done."}]}\n```';
    const out = parsePrepResponse(raw);
    expect(out.lang).toBe("en");
    expect(out.chunks[0]?.text).toBe("[pause] Done.");
  });

  test("defaults a missing style to empty string", () => {
    const out = parsePrepResponse('{"lang":"en","chunks":[{"text":"Hi there."}]}');
    expect(out.chunks[0]).toEqual({ style: "", text: "Hi there." });
  });

  test("throws on no JSON object", () => {
    expect(() => parsePrepResponse("not json at all")).toThrow();
  });

  test("throws on empty chunks", () => {
    expect(() => parsePrepResponse('{"lang":"de","chunks":[]}')).toThrow();
  });

  test("throws when a chunk has no text", () => {
    expect(() => parsePrepResponse('{"lang":"de","chunks":[{"style":"x"}]}')).toThrow();
  });
});
