import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configurationIssue, processVideo } from './analysis.mjs';

const video = new URL('./test-data/01_project_meeting.mp4', import.meta.url);
const summary = { summary: 'Обсудили запуск.', decisions: [], tasks: [], open_questions: [] };

test('sends the original video in both transcription modes', async t => {
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_BASE_URL = 'https://provider.example/v1/';
  process.env.STT_MODEL = 'test-transcription';
  process.env.SUMMARY_MODEL = 'test-summary';
  const bytes = await readFile(video);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/audio/transcriptions')) return Response.json({ text: 'Текст встречи.' });
    const body = JSON.parse(options.body);
    if (body.model === 'test-transcription') return Response.json({ choices: [{ message: { content: 'Текст встречи.' } }] });
    return Response.json({ choices: [{ message: { content: JSON.stringify(summary) } }] });
  });

  for (const mode of ['chat_audio', 'transcriptions']) {
    calls.length = 0;
    process.env.TRANSCRIPTION_MODE = mode;
    const result = await processVideo(fileURLToPath(video));
    assert.equal(result.transcript, 'Текст встречи.');
    assert.deepEqual(result.summary, summary);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].url, 'https://provider.example/v1/chat/completions');
    if (mode === 'chat_audio') {
      assert.equal(calls[0].url, 'https://provider.example/v1/chat/completions');
      const audio = JSON.parse(calls[0].options.body).messages[0].content[1].input_audio;
      assert.equal(audio.format, 'mp4');
      assert.deepEqual(Buffer.from(audio.data, 'base64'), bytes);
    } else {
      assert.equal(calls[0].url, 'https://provider.example/v1/audio/transcriptions');
      const file = calls[0].options.body.get('file');
      assert.equal(file.type, 'video/mp4');
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
    }
  }
});

test('rejects malformed video and invalid configuration before calling the provider', async t => {
  process.env.OPENAI_API_KEY = 'test-key';
  process.env.OPENAI_BASE_URL = 'https://provider.example/v1';
  process.env.STT_MODEL = 'test-transcription';
  process.env.SUMMARY_MODEL = 'test-summary';
  process.env.TRANSCRIPTION_MODE = 'chat_audio';
  const mocked = t.mock.method(globalThis, 'fetch', () => assert.fail('Unexpected provider request'));
  const directory = await mkdtemp(join(tmpdir(), 'meeting-analysis-test-'));
  try {
    const file = join(directory, 'invalid.mp4');
    await writeFile(file, 'not a video');
    await assert.rejects(processVideo(file), /повреждено|формат/);
    assert.equal(mocked.mock.callCount(), 0);
    process.env.TRANSCRIPTION_MODE = 'invalid';
    assert.match(configurationIssue(), /TRANSCRIPTION_MODE/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
