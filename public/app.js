'use strict';
const pick = document.querySelector('#choose');
const fileInput = document.querySelector('#file');
const items = document.querySelector('#meetings');
const empty = document.querySelector('#empty');
const detail = document.querySelector('#detail');
const status = document.querySelector('#status');
const alert = document.querySelector('#request-error');
const labels = { processing: 'Обрабатывается', ready: 'Готово', error: 'Ошибка' };
const formatter = new Intl.DateTimeFormat('ru', { dateStyle: 'medium', timeStyle: 'short' });
let history = [];
let active = null;
let rendered = null;
let busy = false;
let pending = false;
let configurationIssue = null;
let message = '';
let listVersion = '';
let detailRequest = 0;

function create(tag, text = '', css = '') {
  const element = document.createElement(tag);
  element.textContent = text;
  if (css) element.className = css;
  return element;
}

function updateUpload() {
  const disabled = pending || busy || Boolean(configurationIssue);
  pick.disabled = fileInput.disabled = disabled;
  const retry = detail.querySelector('.retry');
  if (retry) retry.disabled = disabled;
  status.textContent = pending ? 'Загружается…' : busy ? 'Обрабатывается' : '';
  status.hidden = !status.textContent;
  alert.textContent = message || configurationIssue || '';
  alert.hidden = !alert.textContent;
}

async function api(route, options) {
  let response;
  try {
    response = await fetch('/api/meetings' + route, options);
  } catch {
    throw new Error('Нет связи с локальным сервером. Проверьте, что он запущен.');
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Сервер не смог выполнить запрос.');
  return body;
}

function renderHistory() {
  const version = JSON.stringify([history, active]);
  if (version === listVersion) return;
  listVersion = version;
  empty.textContent = 'Здесь появятся загруженные встречи.';
  empty.hidden = history.length > 0;
  items.replaceChildren();
  for (const meeting of history) {
    const button = create('button', '', 'meeting');
    button.type = 'button';
    if (meeting.id === active) button.setAttribute('aria-current', 'true');
    const meta = create('span', '', 'meta');
    const time = create('time', formatter.format(new Date(meeting.created_at)));
    time.dateTime = meeting.created_at;
    meta.append(time, create('span', labels[meeting.status], meeting.status));
    button.append(create('strong', meeting.filename), meta);
    button.addEventListener('click', () => select(meeting.id));
    const item = create('li');
    item.append(button);
    items.append(item);
  }
}

function section(title, initiallyOpen) {
  const block = create('details', '', 'details-block');
  block.open = initiallyOpen;
  block.append(create('summary', title));
  detail.append(block);
  return block;
}

function appendList(parent, title, values, emptyText) {
  parent.append(create('h3', title));
  if (!values.length) {
    parent.append(create('p', emptyText, 'muted'));
    return;
  }
  const list = create('ul');
  for (const value of values) list.append(create('li', value));
  parent.append(list);
}

function renderDetail(meeting) {
  const key = meeting.id + meeting.status;
  if (rendered === key) return;
  rendered = key;
  detail.hidden = false;
  detail.replaceChildren(create('h2', meeting.filename), create('p', labels[meeting.status], meeting.status));
  if (meeting.error) {
    const retry = create('button', 'Загрузить снова', 'retry');
    retry.type = 'button';
    retry.onclick = () => fileInput.click();
    detail.append(create('p', meeting.error, 'error'), retry);
  }
  if (meeting.summary) {
    const report = section('Конспект', true);
    const { summary, decisions, tasks, open_questions: openQuestions } = meeting.summary;
    report.append(create('h3', 'Краткое содержание'), create('p', summary));
    appendList(report, 'Решения', decisions, 'Решений нет.');
    appendList(report, 'Задачи', tasks.map(({ action, assignee, due }) =>
      [action, assignee ? 'Исполнитель — ' + assignee : 'Исполнитель не указан',
        due ? 'Срок — ' + due : 'Срок не указан'].join(' · ')), 'Задач нет.');
    appendList(report, 'Открытые вопросы', openQuestions, 'Открытых вопросов нет.');
  }
  if (meeting.transcript) section('Расшифровка', false).append(create('p', meeting.transcript, 'transcript'));
  updateUpload();
}

async function select(id) {
  active = id;
  const request = ++detailRequest;
  renderHistory();
  try {
    const result = await api('/' + id);
    if (request === detailRequest && active === id) renderDetail(result);
  } catch (error) {
    if (request !== detailRequest) return;
    message = error.message;
    updateUpload();
  }
}

async function refresh() {
  const snapshot = await api('');
  history = snapshot.meetings;
  busy = snapshot.busy;
  configurationIssue = snapshot.configuration_issue;
  if (!active && history.length) active = history[0].id;
  renderHistory();
  updateUpload();
  const selected = history.find(meeting => meeting.id === active);
  if (selected && rendered !== selected.id + selected.status) await select(selected.id);
}

pick.onclick = () => fileInput.click();
fileInput.onchange = async () => {
  const file = fileInput.files[0];
  fileInput.value = '';
  if (!file || pending || busy) return;
  pending = true;
  message = '';
  updateUpload();
  const form = new FormData();
  form.set('file', file);
  try {
    const result = await api('', { method: 'POST', body: form });
    busy = true;
    await select(result.id);
    await refresh();
  } catch (error) {
    message = error.message;
  } finally {
    pending = false;
    updateUpload();
  }
};

async function poll() {
  try {
    if (!pending) await refresh();
  } catch (error) {
    configurationIssue = error.message;
    if (!history.length && !empty.hidden) empty.textContent = 'История сейчас недоступна.';
    updateUpload();
  } finally {
    setTimeout(poll, 2000);
  }
}
void poll();
