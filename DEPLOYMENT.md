# Инструкция по деплою

Проект настроен для автоматического деплоя на сервер 192.168.1.95 с использованием Docker и Traefik.

## Архитектура

```
Internet → Nginx (Proxmox, SSL) → Traefik (192.168.1.95:8080) → dixel-app (Docker)
```

## Требования на сервере

1. **Docker и Docker Compose** должны быть установлены
2. **Порт 8080** должен быть доступен для nginx
3. **Внешний nginx** должен быть настроен для проксирования на 192.168.1.95:8080

## Подготовка к деплою

### 1. Убедитесь, что .env файл настроен

```bash
# Проверьте наличие .env файла
cat .env
```

Файл должен содержать:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ADMIN_ID` (опционально, по умолчанию 314009331)
- `PORT=3000`

### 2. Настройте SSH доступ к серверу

Убедитесь, что у вас есть SSH доступ:
```bash
ssh root@192.168.1.95
```

## Деплой

### Из Linux/macOS/Git Bash:

```bash
chmod +x deploy.sh
./deploy.sh
```

### Из Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File deploy.ps1
```

## Настройка внешнего Nginx

На сервере с nginx (Proxmox) добавьте конфигурацию:

```bash
# Скопируйте конфиг на nginx сервер
scp nginx-upstream.conf root@nginx-server:/etc/nginx/sites-available/opt-zakaz.dixel.store

# Включите конфигурацию
ln -s /etc/nginx/sites-available/opt-zakaz.dixel.store /etc/nginx/sites-enabled/

# Проверьте конфигурацию
nginx -t

# Перезагрузите nginx
systemctl reload nginx
```

Или вручную добавьте в существующий конфиг:

```nginx
upstream dixel_traefik {
    server 192.168.1.95:8080;
}

server {
    listen 443 ssl http2;
    server_name opt-zakaz.dixel.store;
    
    # Ваши SSL сертификаты
    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;
    
    location / {
        proxy_pass http://dixel_traefik;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Что происходит при деплое

1. ✅ Проверка наличия .env файла
2. 📁 Создание директории `/opt/dixel-mini-app` на сервере
3. 📤 Копирование файлов на сервер через scp
4. 🐳 Сборка Docker образа приложения
5. 🚀 Запуск контейнеров (Traefik на :8080 + приложение + бот)
6. 🌐 Nginx проксирует трафик на Traefik

## Структура деплоя

```
Internet (HTTPS)
  ↓
Nginx (Proxmox) - SSL termination
  ↓ HTTP
Traefik (192.168.1.95:8080) - Docker routing
  ↓
dixel-mini-app (контейнер) - Express :3000
dixel-bot (контейнер) - long polling к Telegram API
```

## После деплоя

Приложение будет доступно по адресу: **https://opt-zakaz.dixel.store**

### Полезные команды

**Просмотр логов:**
```bash
ssh root@192.168.1.95 'cd /opt/dixel-mini-app && docker-compose logs -f'
```

**Просмотр логов только приложения:**
```bash
ssh root@192.168.1.95 'cd /opt/dixel-mini-app && docker-compose logs -f dixel-app'
```

**Просмотр логов только бота:**
```bash
ssh root@192.168.1.95 'cd /opt/dixel-mini-app && docker compose logs -f dixel-bot'
```

**Рестарт приложения:**
```bash
ssh root@192.168.1.95 'cd /opt/dixel-mini-app && docker-compose restart dixel-app'
```

**Остановка всех контейнеров:**
```bash
ssh root@192.168.1.95 'cd /opt/dixel-mini-app && docker-compose down'
```

**Пересборка и перезапуск:**
```bash
ssh root@192.168.1.95 'cd /opt/dixel-mini-app && docker-compose up -d --build'
```

## Troubleshooting

### Nginx не может подключиться к Traefik

1. Проверьте, что Traefik работает:
```bash
ssh root@192.168.1.95 'curl -I http://localhost:8080 -H "Host: opt-zakaz.dixel.store"'
```

2. Проверьте логи Traefik:
```bash
ssh root@192.168.1.95 'cd /opt/dixel-mini-app && docker compose logs traefik'
```

3. Убедитесь, что порт 8080 доступен с nginx сервера:
```bash
# С nginx сервера
telnet 192.168.1.95 8080
# или
curl -I http://192.168.1.95:8080 -H "Host: opt-zakaz.dixel.store"
```

### Приложение не запускается

1. Проверьте переменные окружения:
```bash
ssh root@192.168.1.95 'cd /opt/dixel-mini-app && cat .env'
```

2. Проверьте логи приложения:
```bash
ssh root@192.168.1.95 'cd /opt/dixel-mini-app && docker-compose logs dixel-app'
```

### Порт 8080 занят

Если порт 8080 уже используется:
```bash
ssh root@192.168.1.95 'ss -tulpn | grep :8080'
```

Измените порт в `docker-compose.yml`:
```yaml
ports:
  - "8081:80"  # Используйте другой порт
```

И обновите конфигурацию nginx соответственно.

## Ручной деплой

Если автоматический скрипт не работает, можно выполнить деплой вручную:

```bash
# 1. Подключитесь к серверу
ssh root@192.168.1.95

# 2. Создайте директорию
mkdir -p /opt/dixel-mini-app
cd /opt/dixel-mini-app

# 3. Скопируйте файлы с локальной машины (в другом терминале)
scp -r * root@192.168.1.95:/opt/dixel-mini-app/

# 4. На сервере запустите контейнеры
cd /opt/dixel-mini-app
docker-compose up -d --build

# 5. Проверьте статус
docker-compose ps
docker-compose logs
```

## Обновление приложения

Для обновления просто запустите скрипт деплоя снова:
```bash
./deploy.sh  # или deploy.ps1 в PowerShell
```

Он автоматически:
- Остановит старые контейнеры
- Скопирует новые файлы
- Пересоберёт образ
- Запустит новую версию
