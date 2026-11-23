import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localTranscriber } from '../dist/voice.js';

const note = { file_id: 'voice-file', duration: 3 };
const signal = new AbortController().signal;

test('voice transcription bounds duration and download size', async () => {
  let downloads = 0;
  const transcribe = localTranscriber('/model', 'unused-whisper', 'unused-ffmpeg', async () => {
    downloads++;
    return new Response(new ReadableStream({ start(stream) {
      stream.enqueue(new Uint8Array(6 * 1024 * 1024));
      stream.enqueue(new Uint8Array(5 * 1024 * 1024));
      stream.close();
    } }));
  });
  await assert.rejects(transcribe({ ...note, duration: 121 }, signal), /two minutes/);
  await assert.rejects(transcribe({ ...note, file_size: 11 * 1024 * 1024 }, signal), /10 MiB/);
  assert.equal(downloads, 0);
  await assert.rejects(transcribe(note, signal), /10 MiB/);
  assert.equal(downloads, 1);
});

test('voice transcription passes audio between local tools and cleans its workspace', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'codex-tg-voice-test-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const ffmpeg = join(fixture, 'ffmpeg');
  const whisper = join(fixture, 'whisper-cli');
  const pathRecord = join(fixture, 'audio-dir');
  await writeFile(ffmpeg, `#!/usr/bin/env node\nconst fs = require('node:fs');
const args = process.argv.slice(2);
fs.copyFileSync(args[args.indexOf('-i') + 1], args.at(-1));\n`, { mode: 0o700 });
  await writeFile(whisper, `#!/usr/bin/env node\nconst fs = require('node:fs');
const args = process.argv.slice(2);
const audio = args[args.indexOf('-f') + 1];
fs.writeFileSync(${JSON.stringify(pathRecord)}, process.cwd());
fs.writeFileSync(args[args.indexOf('-of') + 1] + '.txt', fs.readFileSync(audio));\n`, { mode: 0o700 });
  let contents = '  Send this transcript.  ';
  const transcribe = localTranscriber('/model', whisper, ffmpeg, async fileId => {
    assert.equal(fileId, note.file_id);
    return new Response(contents);
  });
  assert.equal(await transcribe(note, signal), 'Send this transcript.');
  await assert.rejects(readFile(join(await readFile(pathRecord, 'utf8'), 'note.wav')), { code: 'ENOENT' });
  contents = '  ';
  await assert.rejects(transcribe(note, signal), /No speech/);
  await assert.rejects(readFile(join(await readFile(pathRecord, 'utf8'), 'note.ogg')), { code: 'ENOENT' });
});

test('voice failures identify the failed phase without exposing provider or process errors', async () => {
  const failedDownload = localTranscriber('/model', 'unused', 'unused', async () => { throw new Error('private provider details'); });
  await assert.rejects(failedDownload(note, signal), { stage: 'download', message: 'Downloading the voice note failed. Please try again.' });
  const failedConvert = localTranscriber('/model', 'unused', '/does-not-exist', async () => new Response('audio'));
  await assert.rejects(failedConvert(note, signal), { stage: 'conversion', message: 'Converting the voice note failed. Please try again.' });
});
