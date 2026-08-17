# XRay Uptime Monitor

Небольшой сервис для мониторинга доступности серверов из XRay-подписки. Он скачивает подписку, поддерживает URI `vless`, `vmess`, `trojan` и `ss`, поднимает краткоживущий XRay SOCKS-туннель для каждого узла и делает через него HTTP-проверку. История хранится в SQLite.

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
   TEST_URL=https://www.gstatic.com/generate_204
   TEST_TIMEOUT_MS=5000
   ADMIN_LOGIN=admin
   ADMIN_PASSWORD=change_me
   SESSION_SECRET=replace_with_a_long_random_value
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

7. Создайте отдельный файл окружения для Caddy. Он содержит только домен и локальный порт, а не ссылку подписки:

   ```sh
   cp /root/uptime/caddy/.env.example /root/uptime/caddy/.env
   nano /root/uptime/caddy/.env
   ```

   Укажите в нём `DOMAIN=status.example.com` и `PORT=3000`.

8. Установите systemd-unit из репозитория. Команды рассчитаны на путь `/root/uptime`, в котором находится проект:

   ```sh
   sudo install -d -m 700 /root/uptime/caddy/data /root/uptime/caddy/config
   sudo install -m 644 /root/uptime/caddy/xray-uptime-caddy.service /etc/systemd/system/xray-uptime-caddy.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now xray-uptime-caddy
   ```

9. Проверьте выпуск сертификата и откройте `https://ваш-домен`:

   ```sh
   sudo journalctl -u xray-uptime-caddy -f
   ```

SQLite хранится в именованном томе `monitor-data`, поэтому история не пропадает после пересоздания контейнера. Для просмотра журналов приложения используйте `docker compose logs -f app`.

Конфигурация системного Caddy находится в `caddy/Caddyfile`, а unit - в `caddy/xray-uptime-caddy.service`. Caddy читает `DOMAIN` и `PORT` из `/root/uptime/caddy/.env`; если проект находится в другом месте, замените `/root/uptime` на фактический путь в unit-файле до его установки.

## Переменные окружения

| Переменная | Назначение | По умолчанию |
| --- | --- | --- |
| `SUBSCRIPTION_URL` | URL XRay-подписки | обязательно |
| `CHECK_INTERVAL_SECONDS` | Интервал проверок через XRay | `60` |
| `SUBSCRIPTION_REFRESH_SECONDS` | Интервал скачивания подписки | `300` |
| `TEST_URL` | URL, запрашиваемый через конкретный XRay-узел | `https://www.gstatic.com/generate_204` |
| `TEST_TIMEOUT_MS` | Максимальная длительность HTTP-проверки | `5000` |
| `ADMIN_LOGIN` | Логин панели управления | `admin` |
| `ADMIN_PASSWORD` | Пароль панели управления | обязательно изменить |
| `SESSION_SECRET` | Случайный секрет подписи cookie-сессии | обязательно изменить |
| `DOMAIN` | Домен для Caddy | обязательно |
| `PORT` | Внутренний HTTP-порт приложения | `3000` |
| `DATABASE_PATH` | Путь к SQLite-файлу | `/app/data/monitor.db` в контейнере |

## API

- `GET /api/servers` - публичные серверы: только имя, статус, latency, uptime и время проверки.
- `GET /api/servers/:id/history?range=24h` - измерения за `24h`, `7d` или `30d`.
- `GET /api/summary` - количество доступных серверов и средний отклик.

При ошибке загрузки подписки приложение сохраняет последний полученный список серверов, продолжает его проверять и показывает сообщение об ошибке в интерфейсе.

## Админ-панель

Откройте `https://ваш-домен/admin` и войдите с `ADMIN_LOGIN` / `ADMIN_PASSWORD`. В панели показаны только имена серверов и время их последней проверки. Переключатель «Показывать» управляет видимостью сервера на публичной главной странице: скрытые серверы всё равно проверяются и сохраняют историю. IP-адреса, домены, порты, протоколы и исходные URI не выдаются публичными API или интерфейсом.

После первого запуска обязательно замените `ADMIN_PASSWORD` и `SESSION_SECRET` на уникальные значения, затем выполните `docker compose up -d --build`.

## Локальная разработка

Требуется Node.js 22.5 или новее.

```sh
npm install
npm run dev
```

Интерфейс будет доступен по адресу `http://localhost:3000`.
