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

3. Направьте DNS-записи `A` и, при необходимости, `AAAA` домена на IP сервера. Порты `80` и `443` должны быть доступны извне: Caddy использует их для выпуска и продления сертификата Let's Encrypt.

4. Запустите сервис:

   ```sh
   docker compose up -d --build
   ```

5. Откройте `https://ваш-домен`. Первые статусы появятся после начального скачивания подписки и TCP-проверки.

SQLite хранится в именованном томе `monitor-data`, поэтому история не пропадает после пересоздания контейнера. Для просмотра журналов используйте `docker compose logs -f app`.

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
