# DIXEL Mini App MVP

MVP для B2B-клиентов с поиском, вложенными категориями и заказом через Telegram WebApp.

Что сделано:
- Поиск по артикулу и названию
- Дерево категорий с вложенностью (поддержка 3-6 уровней и больше)
- Переключение ценовых режимов: база, -5%, -8%, -10%
- Корзина, отправка заказа в Telegram, история заказов (статусы-заглушки)
- Автоавторизация в Telegram WebApp, демо-вход в браузере

Файлы:
- `index.html` — интерфейс и логика
- `dixel_complete.yml` — каталог (грузится на клиенте)
- `supabase_schema.sql` — схема БД для Supabase

## Локальный запуск
1. Откройте папку проекта.
2. Запустите локальный сервер:
   ```powershell
   python -m http.server 8000
   ```
3. Откройте `http://localhost:8000`.

## Публикация в Telegram Mini App
1. Разместите `index.html` и `dixel_complete.yml` на HTTPS-хостинге (Vercel/Cloudflare Pages/GitHub Pages).
2. Создайте бота в BotFather (`/newbot`).
3. Установите домен WebApp (`/setdomain`).
4. Добавьте кнопку Web App в меню бота:
   - `/setmenubutton`
   - URL: `https://ваш-домен/index.html`
5. Откройте бота в Telegram, запустите Mini App.

Заказ отправляется в бота через `Telegram.WebApp.sendData()`. В боте ловите `web_app_data`:
```js
// Пример (Node.js / Telegraf)
bot.on("message", (ctx) => {
  if (ctx.message.web_app_data) {
    const payload = JSON.parse(ctx.message.web_app_data.data);
    console.log(payload);
  }
});
```

## Supabase (бэкэнд)
1. Откройте Supabase SQL Editor и выполните `supabase_schema.sql`.
2. Импортируйте категории и товары из YML (можно через CSV/скрипт).
3. Для продакшена: проверяйте `initData` Telegram на сервере и пишите в Supabase через service role. Не храните service key в браузере.

## Примечания
- `dixel_complete.yml` должен лежать рядом с `index.html`.
- История заказов сейчас хранится в `localStorage` (можно заменить на Supabase позже).
