import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const maxBytes = 10 * 1024 * 1024;
const maxSeconds = 120;

export type VoiceNote = { file_id: string; duration: number; file_size?: number };
export type TranscribeVoice = (note: VoiceNote, signal: AbortSignal) => Promise<string>;
type DownloadVoice = (fileId: string, signal: AbortSignal) => Promise<Response>;

class VoiceError extends Error {}

async function readVoice(response: Response): Promise<Buffer> {
  if (!response.ok || !response.body) throw new VoiceError('Telegram could not provide the voice note. Please resend it.');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    if (Number(response.headers.get('content-length')) > maxBytes) {
      throw new VoiceError('Voice notes must be 10 MiB or smaller. Please split the recording.');
    }
    for (;;) {
      const part = await reader.read();
      if (part.done) return Buffer.concat(chunks, size);
      size += part.value.byteLength;
      if (size > maxBytes) throw new VoiceError('Voice notes must be 10 MiB or smaller. Please split the recording.');
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function localTranscriber(model: string, whisper: string, ffmpeg: string, download: DownloadVoice): TranscribeVoice {
  return async (note, shutdown) => {
    if (!Number.isInteger(note.duration) || note.duration < 0 || note.duration > maxSeconds) {
      throw new VoiceError('Voice notes must be two minutes or shorter. Please split the recording.');
    }
    if (note.file_size !== undefined && note.file_size > maxBytes) {
      throw new VoiceError('Voice notes must be 10 MiB or smaller. Please split the recording.');
    }
    const timeout = AbortSignal.timeout(120_000);
    const signal = AbortSignal.any([shutdown, timeout]);
    const dir = await mkdtemp(join(tmpdir(), 'codex-telegram-voice-'));
    try {
      const ogg = join(dir, 'note.ogg');
      const wav = join(dir, 'note.wav');
      const output = join(dir, 'transcript');
      const response = await download(note.file_id, signal);
      await writeFile(ogg, await readVoice(response), { mode: 0o600, signal });
      const options = {
        cwd: dir, signal, killSignal: 'SIGKILL' as const, maxBuffer: 128 * 1024,
        env: { PATH: process.env.PATH, LANG: process.env.LANG },
      };
      await run(ffmpeg, ['-nostdin', '-loglevel', 'error', '-protocol_whitelist', 'file', '-f', 'ogg', '-i', ogg,
        '-map', '0:a:0', '-t', String(maxSeconds), '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], options);
      await run(whisper, ['-m', model, '-f', wav, '-l', 'auto', '-nt', '-np', '-otxt', '-of', output], options);
      const transcript = (await readFile(`${output}.txt`, { encoding: 'utf8', signal })).trim();
      if (!transcript) throw new VoiceError('No speech was transcribed. Please send another voice note.');
      return transcript;
    } catch (error) {
      if (error instanceof VoiceError) throw error;
      if (timeout.aborted) throw new VoiceError('Transcription timed out. Please try a shorter voice note.');
      throw new VoiceError('Voice transcription failed. Check the local ffmpeg, whisper-cli, and model settings.');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
