# XRay Uptime Monitor

Небольшой сервис для мониторинга доступности серверов из XRay-подписки. Он скачивает подписку, поддерживает URI `vless`, `vmess`, `trojan` и `ss`, делает TCP-проверку каждого `host:port` и хранит результаты в SQLite.

## Запуск

1. Создайте файл окружения:

   ```sh
   cp .env.example .env
   ```

2. В `.env` укажите настоящие `SUBSCRIPTION_URL` и `DOMAIN`.

   ```dotenv
   SUBSCRIPTION_URL=https://provider.example/sub/your-token
   CHECK_INTERVAL_SECONDS=60
   SUBSCRIPTION_REFRESH_SECONDS=300
   DOMAIN=status.example.com
   PORT=3000
   ```

3. Направьте DNS-записи `A` и, при необходимости, `AAAA` домена на IP сервера. Порты `80` и `443` должны быть доступны извне и не должны использоваться другим reverse proxy.

4. Запустите приложение. Оно будет доступно только локально на `127.0.0.1:3000`:

   ```sh
   docker compose up -d --build
   ```

5. Установите Caddy как системный пакет, если его ещё нет:

   ```sh
   sudo apt update
   sudo apt install -y caddy
   ```

6. Отключите стандартный unit пакета Caddy: для сайта используется отдельный unit из этого проекта.

   ```sh
   sudo systemctl disable --now caddy
   ```

7. Установите systemd-unit из репозитория. Команды рассчитаны на путь `/root/uptime`, в котором находится проект:

   ```sh
   sudo install -d -m 700 /root/uptime/caddy/data /root/uptime/caddy/config
   sudo install -m 644 /root/uptime/caddy/xray-uptime-caddy.service /etc/systemd/system/xray-uptime-caddy.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now xray-uptime-caddy
   ```

8. Проверьте выпуск сертификата и откройте `https://ваш-домен`:

   ```sh
   sudo journalctl -u xray-uptime-caddy -f
   ```

SQLite хранится в именованном томе `monitor-data`, поэтому история не пропадает после пересоздания контейнера. Для просмотра журналов приложения используйте `docker compose logs -f app`.

Конфигурация системного Caddy находится в `caddy/Caddyfile`, а unit - в `caddy/xray-uptime-caddy.service`. Caddy читает `DOMAIN` и `PORT` из `/root/uptime/.env`; если проект находится в другом месте, замените `/root/uptime` на фактический путь в unit-файле до его установки.

## Переменные окружения

| Переменная | Назначение | По умолчанию |
| --- | --- | --- |
| `SUBSCRIPTION_URL` | URL XRay-подписки | обязательно |
| `CHECK_INTERVAL_SECONDS` | Интервал TCP-проверок | `60` |
| `SUBSCRIPTION_REFRESH_SECONDS` | Интервал скачивания подписки | `300` |
| `CONNECT_TIMEOUT_MS` | Таймаут одного TCP-соединения | `4000` |
| `DOMAIN` | Домен для Caddy | обязательно |
| `PORT` | Внутренний HTTP-порт приложения | `3000` |
| `DATABASE_PATH` | Путь к SQLite-файлу | `/app/data/monitor.db` в контейнере |

## API

- `GET /api/servers` - серверы, последний статус, latency и uptime за 24 часа.
- `GET /api/servers/:id/history?range=24h` - измерения за `24h`, `7d` или `30d`.
- `GET /api/summary` - количество доступных серверов и средний отклик.

При ошибке загрузки подписки приложение сохраняет последний полученный список серверов, продолжает его проверять и показывает сообщение об ошибке в интерфейсе.

## Локальная разработка

Требуется Node.js 22.5 или новее.

```sh
npm install
npm run dev
```

Интерфейс будет доступен по адресу `http://localhost:3000`.
