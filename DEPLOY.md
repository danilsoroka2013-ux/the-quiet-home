# GitHub Pages package

This folder is a static build of The Quiet Home. It contains no Node server or build-time dependencies.

## Publish

1. If online play is wanted, keep `src/firebase-config.js` with the Firebase Web App client values (see the “Онлайн и Firebase” checklist below). These are public client settings; never add a service-account/private key.
2. Upload the contents of this folder (not the folder wrapper) to the repository root or to a GitHub Pages /docs folder. Relative URLs support repository subpaths such as https://USER.github.io/REPOSITORY/.
3. Enable Pages for the branch/folder in the repository settings.

Firebase JS modules are loaded from Firebase's HTTPS CDN only when Firebase is configured.

## Онлайн и Firebase (сводка диагностики и настройки)

Текущая сборка смотрит на проект `the-quiet-home` (Realtime Database `the-quiet-home-default-rtdb`, регион europe-west1).
Живой сайт: https://danilsoroka2013-ux.github.io/the-quiet-home/

Что было и что сделано в коде:

- Раньше при любой ошибке Firebase (выключенный анонимный вход, закрытая правилами база, недоступный CDN/блокировщик) игра молча запускалась в одиночном режиме — из-за этого «онлайн не работает» выглядел как загадочный баг.
- Теперь подключение ограничено тайм-аутом 9 секунд, а причина отказа показывается в HUD («ОНЛАЙН НЕДОСТУПЕН — …») и в консоли. Если база запретит уже после подключения, подпишчики `onValue` тоже сообщают об ошибке.
- Распространённая причина «молчаливого» отказа: база создана в Test Mode, и через 30 дней правила автоматически закрылись (`.read/.write: false`). Именно это произошло со старым проектом `game-6fe2f` (база `game-6fe2f-default-rtdb`, письма от 23–29.06.2026, доступ закрыт ~30.06.2026). Если захотите вернуться к старому проекту — там тоже нужно опубликовать правила и вернуть старый конфиг; проще остаться на проекте `the-quiet-home`.

Что нужно сделать в консоли Firebase (один раз, на стороне владельца проекта):

1. **Rules для Realtime Database.** Откройте [консоль Firebase](https://console.firebase.google.com/) → проект `the-quiet-home` → Build → Realtime Database → выбрать базу `the-quiet-home-default-rtdb` → вкладка **Rules** → вставить содержимое файла `database.rules.json` из репозитория → **Publish**.
   Либо через CLI: `npm i -g firebase-tools && firebase login && firebase deploy --only database` (файлы `firebase.json` и `.firebaserc` уже в репозитории).
2. **Анонимный вход.** Build → Authentication → Sign-in method → **Anonymous** → Enable → Save. Без этого `signInAnonymously` отклоняется и онлайн не стартует.
3. **Существование базы.** Если в проекте `the-quiet-home` базы Realtime Database нет — создайте её (регион europe-west1) и сверьте `databaseURL` в `src/firebase-config.js` с адресом, который покажет консоль (у новой базы в другом регионе URL будет другим). Если база и так есть — ничего менять не надо.
4. **GitHub secret scanning.** Сканер GitHub пометил `src/firebase-config.js` (ключ API). Это публичный клиентский ключ Firebase — он намеренно виден всем; отзывать или удалять его НЕЛЬЗЯ (сайт перестанет подключаться). Вместо этого: отметьте алерт в GitHub как false positive / «used in public client», при желании ограничьте ключ реферером `https://danilsoroka2013-ux.github.io/*` в Google Cloud Console → Credentials (это не обязательно — ключ Firebase по дизайну не является секретом; защиту дают правила базы, см. пункт 1).
5. **Авторизованные домены** (Authentication → Settings → Authorized domains) добавлять не обязательно для анонимного входа; понадобится только если позже включите Email/Google-провайдеры — тогда добавьте `danilsoroka2013-ux.github.io`.

Проверка после публикации правил: открыть игру на двух вкладках/устройствах → обе нажимают «ИГРАТЬ» → в правом верхнем углу должен появиться индикатор «ОНЛАЙН · 2/4», игроки видят друг друга. Если вместо этого красная плашка с текстом — там теперь указана конкретная причина (см. подсказки на плашке).

### Правила (`database.rules.json`)

Минимальные правила: читать и писать в `matchmaking/quick` и `rooms/<roomId>` может любой вошедший анонимно пользователь; всё остальное закрыто. Для прототипа этого достаточно; для релиза стоит сузить схему (валидация полей игроков/мира, ограничение размеров, App Check). Не добавляйте глубокие `.validate` без необходимости: транзакции пишут целые поддеревья (например, карту `players`), и строгие правила по `$uid` сломают вход.
