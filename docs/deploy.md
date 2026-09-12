# Запуск на VPS Ubuntu 24.04

VPS відкладено: зараз використовується поточний Windows-ПК, див. README. Нижче збережено необов’язкову інструкцію нового VPS для текстових команд бота; її не виконували. Для них long polling не потребує вхідних вебпортів. Інтерактивна Mini App додатково потребує HTTPS-адреси (`MAP_URL`) і проксі до сервера карти. Ця Docker-інструкція такого проксі не налаштовує; сервер карти слухає loopback усередині контейнера. Для карти зараз використовуйте перевірений Windows-запуск із Quick Tunnel.

## Підготовка

Після входу через SSH:

```sh
sudo apt-get update
sudo apt-get install -y docker.io git
sudo systemctl enable --now docker
sudo git clone https://github.com/avngrrd/mappibot.git /opt/mappibot
cd /opt/mappibot
sudo docker build -t mappibot:latest .
sudo install -m 600 .env.example /etc/mappibot.env
sudo nano /etc/mappibot.env
```

У `/etc/mappibot.env` заповніть `TELEGRAM_BOT_TOKEN`, випадковий `INVITE_CODE` з 16–64 символів і встановіть `DATA_DIR=/app/data`. Використайте той самий invite code для збереження чинних посилань. Не надсилайте пароль сервера в публічний репозиторій. Для SSH можна додати свій публічний ключ через панель хостингу.

## Постійний процес

Перед запуском VPS-копії зупиніть локальну копію бота: Telegram дозволяє тільки одного споживача polling для токена. Також це забезпечує загальний ліміт Nominatim. Перевірений існуючий webhook автоматично не видаляється.

```sh
sudo docker run -d --name mappibot \
  --restart unless-stopped \
  --env-file /etc/mappibot.env \
  --mount type=volume,src=mappibot-data,dst=/app/data \
  --log-driver local --log-opt max-size=5m --log-opt max-file=3 \
  mappibot:latest
sudo docker logs --tail 30 mappibot
```

Відкрийте бота за посиланням-запрошенням і перевірте пошук, зупинки, обране та `/live`. Помилка Telegram 409 означає, що запущено іншу копію, 401 — недійсний токен.

Стан зберігається у Docker volume `mappibot-data`, а не в образі чи GitHub. Для перенесення існуючих обраних зупинок спочатку зупиніть обидва процеси, перенесіть `state.json` у volume, встановіть власника UID 1000 і лише тоді запускайте сервер. Lock-файл старого процесу не переносити.

## Оновлення

Завантажте код і зберіть образ, поки поточний бот ще працює; замініть контейнер тільки після успішної збірки:

```sh
cd /opt/mappibot
sudo git pull --ff-only
sudo docker build -t mappibot:latest .
sudo docker stop -t 45 mappibot
sudo docker rm mappibot
```

Після цього повторіть `docker run` вище з тим самим volume. Видалення контейнера не видаляє named volume. Не використовуйте `docker volume rm` для робочих даних.

Для резервної копії зупиніть контейнер, скопіюйте `/app/data/state.json` через `docker cp` у захищений файл і запустіть контейнер знову. Копія містить Telegram ID та обране; не зберігайте її в публічному GitHub.
