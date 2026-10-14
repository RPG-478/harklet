const $ = selector => document.querySelector(selector);
const state = { view: 'home', data: null, buttons: [], sending: false, lastEvent: null };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

function toast(message) {
  const box = $('#toast');
  box.textContent = message;
  box.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => box.classList.remove('show'), 4000);
}

async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (response.status === 401) { location.reload(); throw new Error('Session expired'); }
  const result = await response.json();
  if (!response.ok || result.error) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}

function setView(view) {
  state.view = view;
  document.querySelectorAll('.view').forEach(node => node.classList.toggle('active', node.id === `${view}-view`));
  document.querySelectorAll('.nav-item').forEach(node => node.classList.toggle('active', node.dataset.view === view));
  $('#breadcrumb').textContent = view[0].toUpperCase() + view.slice(1);
  $('#main-scroll').scrollTop = 0;
  if (view === 'chat') $('#chat-input').focus();
}

function renderLines(container, items, empty, line) {
  container.replaceChildren();
  if (!items?.length) { container.append(element('p', 'rail-empty', empty)); return; }
  for (const item of items) container.append(line(item));
}

function tile(icon, title, detail, prompt, panelId) {
  const node = element('article', 'tile');
  const body = element('p', '', detail);
  node.append(element('div', 'tile-icon', icon), element('h3', '', title), body);
  if (panelId) {
    const refresh = element('button', '', 'Refresh panel ↗');
    refresh.type = 'button';
    refresh.addEventListener('click', async () => {
      refresh.disabled = true;
      body.textContent = 'Updating…';
      try { body.textContent = (await api('/api/panel', 'POST', { id: panelId })).content; }
      catch (err) { body.textContent = detail; toast(err.message); }
      finally { refresh.disabled = false; }
    });
    node.append(refresh);
  }
  if (prompt) {
    const button = element('button', '', 'Ask Harklet →');
    button.type = 'button';
    button.addEventListener('click', () => { setView('chat'); $('#chat-input').value = prompt; $('#chat-input').focus(); });
    node.append(button);
  }
  return node;
}

function renderWorkspace(data) {
  const now = new Date();
  $('#today-label').textContent = new Intl.DateTimeFormat('en', { month: 'long', day: 'numeric' }).format(now);
  $('#rail-date').textContent = new Intl.DateTimeFormat('en', { weekday: 'long', month: 'short', day: 'numeric' }).format(now);
  $('#rail-greeting').textContent = `Ready when you are, ${data.name}.`;
  $('#avatar').textContent = data.name[0]?.toUpperCase() || 'Y';
  $('#run-status').textContent = data.computerRunning ? 'Handoff running' : 'Ready';
  $('#run-status').classList.toggle('busy', data.computerRunning);
  $('#browser-summary').textContent = data.computerRunning ? 'Working in the browser now. Follow progress in your Discord DM.' : 'Your browser agent is ready when you are.';
  $('#steps-label').textContent = data.steps === 0 ? 'Unlimited steps / task' : `${data.steps} steps / task`;

  const cards = $('#home-cards');
  cards.replaceChildren();
  const reminders = data.reminders ?? [];
  cards.append(tile('◷', 'Reminders', reminders.length ? `${reminders.length} ${reminders.length === 1 ? 'thing' : 'things'} on your list` : 'Nothing waiting for you.', 'リマインダーを確認して'));
  const projectCount = data.projects?.length ?? 0;
  cards.append(tile('◇', 'Projects', projectCount ? `${projectCount} ${projectCount === 1 ? 'project' : 'projects'} in progress` : 'A place for your bigger ideas.', '新しいプロジェクトを考えたい'));
  for (const card of data.cards ?? []) cards.append(tile(card.emoji || '✦', card.title, card.prompt, card.prompt, card.id));
  const panelList = $('#panels-list');
  panelList.replaceChildren();
  if (!data.cards?.length) panelList.append(tile('✦', 'Create your first panel', 'Ask Harklet to make a panel for information you want at a glance.', '今日の予定を表示するHomeカードを作って'));
  else for (const card of data.cards) panelList.append(tile(card.emoji || '✦', card.title, card.prompt, card.prompt, card.id));
  const projects = $('#projects-list');
  projects.replaceChildren();
  if (!data.projects?.length) projects.append(tile('◇', 'Start something new', 'Plan a trip, explore an idea, or keep a longer task organized.', '新しいプロジェクトを作りたい'));
  else for (const project of data.projects) projects.append(tile('◇', project.topic, 'Continue in your Discord project thread.', `プロジェクト「${project.topic}」を続けたい`));
  $('#reminder-count').textContent = String(reminders.length);
  renderLines($('#reminder-list'), reminders.slice(0, 5), 'No reminders yet.', r => {
    const node = element('div', 'rail-line', r.text);
    node.append(element('small', '', new Date(r.due_at).toLocaleString()));
    return node;
  });
  renderLines($('#memory-list'), (data.memories ?? []).slice(0, 4), 'Things you ask me to remember will show up here.', m => element('div', 'rail-line', m.content));
  renderLines($('#event-list'), (data.events ?? []).slice(-3).reverse(), 'No recent activity.', e => element('div', 'rail-line', e.message));
  const latest = data.events?.at(-1);
  if (state.lastEvent && latest?.id !== state.lastEvent && latest) toast(latest.message);
  state.lastEvent = latest?.id ?? null;
}

function appendMessage(role, content, buttons = []) {
  const row = element('div', `message ${role}`);
  if (role !== 'user') row.append(element('div', 'message-avatar', '✳'));
  const bubble = element('div', 'bubble', content);
  if (buttons.length) {
    const actions = element('div', 'message-actions');
    for (const option of buttons) {
      const button = element('button', '', option.label);
      button.type = 'button';
      button.addEventListener('click', async () => {
        button.disabled = true;
        try { const result = await api('/api/action', 'POST', { id: option.id }); appendMessage('assistant', result.message); await refresh(); }
        catch (err) { toast(err.message); button.disabled = false; }
      });
      actions.append(button);
    }
    bubble.append(actions);
  }
  row.append(bubble);
  $('#messages').append(row);
  if (state.view === 'chat') $('#main-scroll').scrollTop = $('#main-scroll').scrollHeight;
}

function renderHistory(data) {
  const list = $('#messages');
  list.replaceChildren();
  if (!data.history?.length) {
    appendMessage('assistant', 'Hi, I’m Harklet. What can I help you move forward today?');
    return;
  }
  for (const message of data.history) appendMessage(message.role === 'user' ? 'user' : 'assistant', message.content);
}

async function refresh() {
  const data = await api('/api/state');
  state.data = data;
  renderWorkspace(data);
}

async function send(text) {
  if (state.sending || !text.trim()) return;
  state.sending = true;
  $('#send-button').disabled = true;
  setView('chat');
  appendMessage('user', text);
  $('#chat-input').value = '';
  const waiting = element('div', 'message assistant');
  waiting.append(element('div', 'message-avatar', '✳'), element('div', 'bubble', 'Thinking…'));
  $('#messages').append(waiting);
  $('#main-scroll').scrollTop = $('#main-scroll').scrollHeight;
  try {
    const result = await api('/api/chat', 'POST', { text });
    waiting.remove();
    appendMessage('assistant', result.reply, result.buttons);
    for (const event of result.events) appendMessage('assistant', event);
    await refresh();
  } catch (err) { waiting.remove(); appendMessage('assistant', `⚠️ ${err.message}`); }
  finally { state.sending = false; $('#send-button').disabled = false; $('#chat-input').focus(); }
}

document.querySelectorAll('.nav-item').forEach(node => node.addEventListener('click', () => setView(node.dataset.view)));
document.querySelectorAll('[data-prompt]').forEach(node => node.addEventListener('click', () => send(node.dataset.prompt)));
$('#hero-chat').addEventListener('click', () => setView('chat'));
$('#composer').addEventListener('submit', event => { event.preventDefault(); send($('#chat-input').value); });
$('#chat-input').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send($('#chat-input').value); } });
refresh().then(() => renderHistory(state.data)).catch(err => toast(err.message));
setInterval(() => { if (!document.hidden) refresh().catch(() => {}); }, 8000);
