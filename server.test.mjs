import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as wait } from 'node:timers/promises';
import { createMeetingServer } from './server.mjs';
import { ProcessingError } from './analysis.mjs';

const example = {
  transcript: 'Подготовить отчёт.',
  summary: { summary: 'Обсудили отчёт.', decisions: [], tasks: [
    { action: 'Подготовить отчёт', assignee: null, due: null },
  ], open_questions: [] },
};

// Drive the same registered request listener without requiring loopback in CI.
async function request(server, path = '/', options = {}) {
  const form = options.body && new Request('http://localhost' + path, {
    method: options.method, body: options.body,
  });
  const body = form ? Buffer.from(await form.arrayBuffer()) : Buffer.alloc(0);
  const input = Readable.from(body.length ? [body] : []);
  input.method = options.method ?? 'GET';
  input.url = path;
  input.headers = form ? Object.fromEntries(form.headers) : {};
  return new Promise((resolve, reject) => {
    let status;
    let headers;
    const output = {
      setHeader() {},
      writeHead(code, fields) {
        status = code;
        headers = fields;
      },
      end(contents) {
        resolve(new Response(contents, { status, headers }));
      },
    };
    try {
      server.emit('request', input, output);
    } catch (error) {
      reject(error);
    }
  });
}

function upload(server, name, content = 'input') {
  const form = new FormData();
  form.set('file', new Blob([content]), name);
  return request(server, '/api/meetings', { method: 'POST', body: form });
}

async function finished(server, id) {
  for (let count = 0; count < 50; count++) {
    const response = await request(server, '/api/meetings/' + id);
    const result = await response.json();
    if (result.status !== 'processing') return result;
    await wait(20);
  }
  assert.fail('Processing did not finish');
}

test('upload, concurrency, persistence and interrupted jobs', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'meeting-test-'));
  const options = { dataDirectory, unavailable: () => null };
  const gate = Promise.withResolvers();
  let server;
  try {
    server = await createMeetingServer({ ...options, processRecording: async path => {
      assert.equal(await readFile(path, 'utf8'), 'input');
      return gate.promise;
    } });
    assert.match(await (await request(server)).text(), /AI-анализатор видеовстреч/);
    assert.equal((await upload(server, 'unsupported.txt')).status, 415);
    const accepted = await upload(server, 'Встреча MP4.mp4');
    assert.equal(accepted.status, 202);
    const { id, status } = await accepted.json();
    assert.equal(status, 'processing');
    assert.equal((await upload(server, 'second.webm')).status, 409);
    const index = await (await request(server, '/api/meetings')).json();
    assert.equal(index.meetings[0].filename, 'Встреча MP4.mp4');
    gate.resolve(example);
    const ready = await finished(server, id);
    assert.equal(ready.status, 'ready');
    assert.deepEqual(ready.summary, example.summary);
    for (let count = 0; count < 50; count++) {
      if (!(await readdir(join(dataDirectory, 'uploads'))).length) break;
      await wait(20);
    }
    assert.deepEqual(await readdir(join(dataDirectory, 'uploads')), []);

    const interrupted = '01234567-0123-4123-a123-012345678901';
    await writeFile(join(dataDirectory, 'meetings', interrupted + '.json'), JSON.stringify({
      id: interrupted, filename: 'interrupted.webm', status: 'processing', created_at: new Date().toISOString(),
    }));
    await mkdir(join(dataDirectory, 'uploads', 'abandoned-audio'));
    server = await createMeetingServer({ ...options, unavailable: () => 'No key' });
    assert.deepEqual(await (await request(server, '/api/meetings/' + id)).json(), ready);
    const recovered = await (await request(server, '/api/meetings/' + interrupted)).json();
    assert.equal(recovered.status, 'error');
    assert.match(recovered.error, /перезапущен/);
    assert.deepEqual(await readdir(join(dataDirectory, 'uploads')), []);
    assert.equal((await upload(server, 'disabled.webm')).status, 503);
  } finally {
    gate.resolve(example);
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test('partial transcript survives an AI error and upload can be retried', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'meeting-test-'));
  let server;
  try {
    let attempts = 0;
    server = await createMeetingServer({ dataDirectory, unavailable: () => null, processRecording: async () => {
      if (++attempts === 1) throw new ProcessingError('Ошибка конспекта.', example.transcript);
      return example;
    } });
    const first = await (await upload(server, 'запись.webm')).json();
    const partial = await finished(server, first.id);
    assert.equal(partial.status, 'error');
    assert.equal(partial.transcript, example.transcript);
    assert.equal(partial.error, 'Ошибка конспекта.');
    assert.equal(partial.summary, null);
    for (let count = 0; count < 50; count++) {
      if (!(await (await request(server, '/api/meetings')).json()).busy) break;
      await wait(10);
    }
    const retry = await (await upload(server, 'запись.webm')).json();
    assert.notEqual(retry.id, first.id);
    assert.equal((await finished(server, retry.id)).status, 'ready');
    for (let count = 0; count < 50; count++) {
      if (!(await (await request(server, '/api/meetings')).json()).busy) break;
      await wait(10);
    }
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
