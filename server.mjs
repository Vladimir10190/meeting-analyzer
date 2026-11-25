import { createServer } from 'node:http';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { readFile, writeFile, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join, extname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { configurationIssue, ProcessingError, processVideo } from './analysis.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
try {
  process.loadEnvFile(join(root, '.env.local'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const maxFile = 250 * 1024 * 1024;
const maxRequest = maxFile + 64 * 1024;
const meetingId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function reply(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function upload(request) {
  const type = request.headers['content-type'] ?? '';
  if (!/^multipart\/form-data\s*;/i.test(type)) throw new HttpError(400, 'Выберите видео MP4 или WebM.');
  const limitError = 'Файл больше 250 МиБ. Выберите видео меньшего размера.';
  const size = Number(request.headers['content-length']);
  if (size > maxRequest) throw new HttpError(413, limitError);

  const controller = new AbortController();
  const reader = request.iterator({ destroyOnReturn: false });
  let received = 0;
  const stream = new ReadableStream({
    async pull(sink) {
      try {
        const { value, done } = await reader.next();
        if (done) return sink.close();
        received += value.length;
        if (received > maxRequest) {
          controller.abort();
          sink.error(new HttpError(413, limitError));
          return;
        }
        sink.enqueue(value);
      } catch (error) {
        sink.error(error);
      }
    },
  });
  let form;
  try {
    form = await new Response(stream, { headers: { 'content-type': type } }).formData();
  } catch {
    if (controller.signal.aborted) throw new HttpError(413, limitError);
    throw new HttpError(400, 'Не удалось прочитать загрузку. Выберите файл снова.');
  }

  const entries = [...form.entries()];
  if (entries.length !== 1 || entries[0][0] !== 'file' || !(entries[0][1] instanceof File)) {
    throw new HttpError(400, 'Выберите один видеофайл.');
  }
  const file = entries[0][1];
  if (!file.size) throw new HttpError(400, 'Файл пуст. Выберите другую запись.');
  if (file.size > maxFile) throw new HttpError(413, limitError);
  const filename = basename(file.name.replaceAll('\\', '/'));
  const extension = extname(filename).toLowerCase();
  if (extension !== '.mp4' && extension !== '.webm') {
    throw new HttpError(415, 'Загрузите видео в формате MP4 или WebM.');
  }
  return { file, filename, extension };
}

export async function createMeetingServer({
  dataDirectory = join(root, 'data'), processRecording, unavailable = configurationIssue,
} = {}) {
  const records = join(dataDirectory, 'meetings');
  const temporary = join(dataDirectory, 'uploads');
  const meetings = new Map();
  let busy = false;

  await mkdir(records, { recursive: true });
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary);
  async function save(record) {
    const target = join(records, record.id + '.json');
    await writeFile(target + '.tmp', JSON.stringify(record, null, 2), 'utf8');
    await rename(target + '.tmp', target);
    meetings.set(record.id, record);
  }

  for (const name of await readdir(records)) {
    const id = name.slice(0, -5);
    if (!name.endsWith('.json') || !meetingId.test(id)) continue;
    try {
      const record = JSON.parse(await readFile(join(records, name), 'utf8'));
      if (record.id !== id || typeof record.created_at !== 'string') continue;
      if (record.status === 'processing') {
        await save({ ...record, status: 'error', error: 'Сервер был перезапущен во время обработки. Загрузите запись снова.' });
      } else {
        meetings.set(id, record);
      }
    } catch {
      console.error('Один файл истории недоступен.');
    }
  }

  async function finish(record, video) {
    let finalRecord;
    try {
      const result = await (processRecording ?? processVideo)(video, temporary);
      finalRecord = { ...record, ...result, status: 'ready' };
    } catch (error) {
      const expected = error instanceof ProcessingError;
      finalRecord = {
        ...record, status: 'error',
        error: expected ? error.message : 'Не удалось обработать запись. Попробуйте загрузить её снова.',
        transcript: expected ? error.transcript : null,
      };
    }
    try {
      await save(finalRecord);
    } catch {
      meetings.set(record.id, { ...finalRecord, status: 'error', error: 'Не удалось сохранить результат на диск.' });
      console.error('Не удалось записать результат встречи.');
    } finally {
      await rm(video, { force: true }).catch(() => console.error('Не удалось удалить временное видео.'));
      busy = false;
    }
  }

  async function submit(request, response) {
    if (busy) throw new HttpError(409, 'Сервер уже обрабатывает запись. Дождитесь её завершения.');
    const issue = unavailable();
    if (issue) throw new HttpError(503, issue);
    busy = true;
    let video;
    try {
      const { file, filename, extension } = await upload(request);
      const id = randomUUID();
      video = join(temporary, id + extension);
      await pipeline(file.stream(), createWriteStream(video, { flags: 'wx' }));
      const record = {
        id, filename, created_at: new Date().toISOString(), status: 'processing',
        transcript: null, summary: null, error: null,
      };
      await save(record);
      reply(response, 202, { id, status: record.status });
      void finish(record, video);
    } catch (error) {
      if (video) await rm(video, { force: true }).catch(() => {});
      busy = false;
      throw error;
    }
  }

  return createServer(async (request, response) => {
    try {
      const { pathname } = new URL(request.url, 'http://localhost');
      const asset = staticFiles.get(pathname);
      if (request.method === 'GET' && asset) {
        const [name, type] = asset;
        const contents = await readFile(join(root, 'public', name));
        response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
        return response.end(contents);
      }
      if (pathname === '/api/meetings') {
        if (request.method === 'POST') {
          // Normal submissions use a same-origin form. Protect localhost from cross-site forms.
          const origin = request.headers.origin;
          if ((origin && origin !== 'http://' + request.headers.host) ||
              request.headers['sec-fetch-site'] === 'cross-site') {
            throw new HttpError(403, 'Загрузка доступна со страницы локального приложения.');
          }
          return await submit(request, response);
        }
        if (request.method === 'GET') {
          const items = [...meetings.values()].sort((a, b) => b.created_at.localeCompare(a.created_at))
            .map(({ id, filename, created_at, status }) => ({ id, filename, created_at, status }));
          return reply(response, 200, { meetings: items, configuration_issue: unavailable(), busy });
        }
      }
      if (request.method === 'GET' && pathname.startsWith('/api/meetings/')) {
        const record = meetings.get(pathname.slice('/api/meetings/'.length));
        if (record) return reply(response, 200, record);
      }
      throw new HttpError(404, 'Страница или встреча не найдена.');
    } catch (error) {
      if (error instanceof HttpError) {
        if (request.method === 'POST' && !request.readableEnded) response.setHeader('connection', 'close');
        return reply(response, error.status, { error: error.message });
      }
      console.error('Ошибка локального сервера.');
      return reply(response, 500, { error: 'Локальный сервер не смог выполнить запрос.' });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? '8000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT должен быть числом от 1 до 65535.');
  const server = await createMeetingServer();
  server.listen(port, '127.0.0.1', () => console.log('http://127.0.0.1:' + port));
}
