const grid = document.querySelector('#server-grid');
const template = document.querySelector('#server-template');
const dialog = document.querySelector('#history-dialog');
let selectedServer = null;
let selectedRange = '24h';

const formatter = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
function text(id, value) { document.querySelector(id).textContent = value; }
function timestamp(value) { return value ? formatter.format(new Date(value)) : 'Нет проверок'; }
function latency(value) { return value === null || value === undefined ? '--' : `${value} мс`; }

function makeCard(server) {
  const node = template.content.cloneNode(true);
  const card = node.querySelector('.server-card');
  const button = node.querySelector('.card-button');
  const online = server.online;
  card.classList.add(online ? 'online' : 'offline');
  node.querySelector('.server-name').textContent = server.name;
  node.querySelector('.status-label').textContent = online ? 'онлайн' : 'офлайн';
  node.querySelector('.endpoint').textContent = `${server.protocol} · ${server.host}:${server.port}`;
  node.querySelector('.latency').textContent = latency(server.latencyMs);
  node.querySelector('.uptime').textContent = `${server.uptime24h}%`;
  node.querySelector('.checked-at').textContent = `Проверено: ${timestamp(server.lastCheckedAt)}`;
  button.addEventListener('click', () => openHistory(server));
  return node;
}

async function updateDashboard() {
  try {
    const [serversResponse, summaryResponse] = await Promise.all([fetch('/api/servers'), fetch('/api/summary')]);
    if (!serversResponse.ok || !summaryResponse.ok) throw new Error('API unavailable');
    const data = await serversResponse.json();
    const summary = await summaryResponse.json();
    text('#online-count', summary.online);
    text('#total-count', summary.total);
    text('#average-latency', latency(summary.averageLatencyMs));
    text('#last-updated', `Последняя проверка: ${timestamp(summary.lastCheckAt)}`);
    const notice = document.querySelector('#subscription-notice');
    notice.classList.toggle('hidden', !data.subscriptionError);
    notice.textContent = data.subscriptionError ? `Не удалось обновить подписку: ${data.subscriptionError}. Показан последний известный список.` : '';
    grid.replaceChildren(...data.servers.map(makeCard));
    document.querySelector('#empty-state').classList.toggle('hidden', data.servers.length > 0);
  } catch {
    text('#last-updated', 'Связь с сервисом потеряна');
  }
}

async function openHistory(server) {
  selectedServer = server;
  selectedRange = '24h';
  document.querySelectorAll('[data-range]').forEach((button) => button.classList.toggle('selected', button.dataset.range === selectedRange));
  text('#history-title', server.name);
  dialog.showModal();
  await loadHistory();
}

async function loadHistory() {
  if (!selectedServer) return;
  const chart = document.querySelector('#history-chart');
  chart.replaceChildren();
  text('#history-uptime', '--');
  text('#history-meta', 'Загрузка истории...');
  try {
    const response = await fetch(`/api/servers/${encodeURIComponent(selectedServer.id)}/history?range=${selectedRange}`);
    if (!response.ok) throw new Error();
    const data = await response.json();
    text('#history-uptime', data.uptime === null ? '--' : `${data.uptime}%`);
    data.checks.forEach((check) => {
      const point = document.createElement('span');
      point.className = `history-point ${check.online ? 'online' : ''}`;
      point.title = `${timestamp(check.checkedAt)}: ${check.online ? latency(check.latencyMs) : 'недоступен'}`;
      chart.append(point);
    });
    if (!data.checks.length) chart.innerHTML = '<span class="history-point empty"></span>';
    text('#history-meta', data.checks.length ? `${data.checks.length} проверок. Наведите на отметку для деталей.` : 'За выбранный период проверок ещё нет.');
  } catch { text('#history-meta', 'Не удалось загрузить историю.'); }
}

document.querySelector('#close-dialog').addEventListener('click', () => dialog.close());
document.querySelectorAll('[data-range]').forEach((button) => button.addEventListener('click', async () => {
  selectedRange = button.dataset.range;
  document.querySelectorAll('[data-range]').forEach((item) => item.classList.toggle('selected', item === button));
  await loadHistory();
}));
updateDashboard();
setInterval(updateDashboard, 15_000);
