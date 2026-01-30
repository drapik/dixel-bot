# Быстрый деплой на 192.168.1.95

## Шаг 1: Проверьте .env файл
```bash
cat .env
```
Убедитесь что все переменные заполнены.

## Шаг 2: Запустите деплой

### Windows (PowerShell):
```powershell
powershell -ExecutionPolicy Bypass -File deploy.ps1
```

### Linux/macOS/Git Bash:
```bash
chmod +x deploy.sh
./deploy.sh
```

## Шаг 3: Настройте внешний Nginx

На сервере с nginx добавьте в конфигурацию:

```nginx
upstream dixel_traefik {
    server 192.168.1.95:8080;
}

server {
    listen 443 ssl http2;
    server_name opt-zakaz.dixel.store;
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    location / {
        proxy_pass http://dixel_traefik;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Затем:
```bash
nginx -t
systemctl reload nginx
```

## Готово! ✅

Приложение доступно: **https://opt-zakaz.dixel.store**

## Проверка

```bash
# Проверить статус контейнеров
ssh root@192.168.1.95 'cd /opt/dixel-mini-app && docker compose ps'

# Посмотреть логи
ssh root@192.168.1.95 'cd /opt/dixel-mini-app && docker compose logs -f'

# Посмотреть логи бота
ssh root@192.168.1.95 'cd /opt/dixel-mini-app && docker compose logs -f dixel-bot'

# Проверить работу Traefik
ssh root@192.168.1.95 'curl -I http://localhost:8080 -H "Host: opt-zakaz.dixel.store"'
```

## Обновление

Просто запустите деплой скрипт снова:
```bash
./deploy.sh  # или deploy.ps1
```
