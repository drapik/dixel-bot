# DIXEL Mini App MVP

MVP для B2B-клиентов с поиском, вложенными категориями и заказом через Telegram WebApp.

Что сделано:
- Поиск по артикулу и названию
- Дерево категорий с вложенностью (поддержка 3-6 уровней и больше)
- Цены скрыты до авторизации, выдаются сервером по назначенному прайс-листу
- Корзина, отправка заказа в Telegram, история заказов в профиле
- Автоавторизация в Telegram WebApp без демо-входа
- Серверный API каталога и цен с проверкой initData

Файлы:
- `index.html` — интерфейс и логика
- `server/index.js` — сервер каталога и цен
- `scripts/import-yml.js` — импорт YML в Supabase
- `scripts/fetch-yml.js` — скачивание YML от поставщика
- `scripts/import-schedule.js` — автозапуск импорта по расписанию
- `supabase_schema.sql` — схема БД для Supabase
- `package.json` — зависимости и команды

## Локальный запуск
1. Откройте папку проекта.
2. Создайте `.env` на основе `.env.example` и заполните ключи Supabase и Telegram.
   При нестабильной сети можно настроить `UPSERT_BATCH_SIZE`, `UPSERT_PRODUCT_BATCH_SIZE`, `UPSERT_RETRIES`, `UPSERT_RETRY_MS`.
3. Установите зависимости:
   ```powershell
   npm install
   ```
4. (Опционально) скачайте YML файл поставщика:
   ```powershell
   npm run fetch-yml
   ```
5. Импортируйте каталог:
   ```powershell
   npm run import-yml
   ```
   Очистка перед импортом (удаляет текущие товары и категории, либо задайте `IMPORT_WIPE=1`):
   ```powershell
   npm run import-yml -- --wipe
   ```
6. (Опционально) Запустите автоимпорт каждые 30 минут:
   ```powershell
   npm run import-schedule
   ```
7. Запустите сервер:
   ```powershell
   npm start
   ```
8. Откройте `http://localhost:3000`.

## Публикация в Telegram Mini App
1. Разверните `server/index.js` на Node-хостинге (Render/Railway/VPS).
2. Создайте бота в BotFather (`/newbot`).
3. Установите домен WebApp (`/setdomain`).
4. Добавьте кнопку Web App в меню бота:
   - `/setmenubutton`
   - URL: `https://ваш-домен/`
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
2. Импортируйте категории и товары из YML (`npm run import-yml`).
3. Скрывайте категории, выставляя `categories.hidden = true` (дочерние скрываются автоматически). Обычный импорт сохраняет `hidden`, а `--wipe` сбрасывает.
4. Назначайте прайс-лист клиентам через `customers.price_tier`.
5. Для продакшена: проверяйте `initData` Telegram на сервере и работайте с Supabase через service role. Не храните service key в браузере.

## Примечания
- `SUPPLIER_YML_URL` — единственный источник каталога, сайт поставщика больше не используется.
- История заказов пока хранится в `localStorage`.
