# План: Функционал вывода средств

## Задача
Добавить в бота возможность вывода USDC на указанный кошелёк.

## Функционал
1. Кнопка "Вывести" в настройках (рядом с "Экспортировать приватный ключ")
2. Пользователь вводит адрес кошелька (проверка: начинается с 0x)
3. Показывается баланс и запрашивается сумма
4. Кнопки: 10%, 20%, 30%, 50%, "Максимум"
5. Вывод на указанный кошелёк

## Файлы для изменения

### 1. src/locales/ru.json
Добавить переводы для:
- settings_withdraw: "Вывести средства"
- withdraw_title: "Вывод средств"
- withdraw_prompt_address: "Введите адрес кошелька (начинается с 0x):"
- withdraw_invalid_address: "Некорректный адрес. Адрес должен начинаться с 0x."
- withdraw_prompt_amount: "Введите сумму для вывода:"
- withdraw_balance: "Баланс: {{amount}} USDC"
- withdraw_confirm: "Подтвердите вывод {{amount}} USDC на кошелёк {{address}}"
- withdraw_success: "Вывод успешно выполнен. Транзакция: {{txHash}}"
- withdraw_error: "Ошибка вывода: {{message}}"
- withdraw_insufficient: "Недостаточно средств. Доступно: {{available}} USDC"

### 2. src/locales/en.json
Аналогичные переводы на английский.

### 3. src/modules/bot/features/withdraw.js (СОЗДАТЬ)
Новый файл с функционалом вывода:
- showWithdrawEntry() - точка входа, показывает кнопку "Вывести"
- startWithdrawFlow() - начало流程: запрос адреса
- handleWithdrawAddress() - обработка введённого адреса, запрос суммы
- handleWithdrawAmount() - обработка введённой суммы
- handleWithdrawPercent() - обработка процентов (10, 20, 30, 50, max)
- executeWithdraw() - выполнение вывода
- withdrawUSDC() - функция вызова контракта USDC.transfer

### 4. src/modules/polymarket.js
Добавить функцию:
- withdrawUSDC(toAddress, amountBase) - вывод USDC на указанный адрес

### 5. src/modules/bot/features/settings.js
Добавить кнопку "Вывести" в клавиатуру настроек.

### 6. src/modules/bot/routing/callback-router.js
Добавить обработку callback для withdraw.

### 7. src/modules/bot/bot.js
Добавить передачу функций withdraw в роутер.

## Тесты
Создать файл tests/withdraw.test.js с моками для проверки:
- Валидации адреса (0x...)
- Расчёта процентов от баланса
- Логики вывода без реальной транзакции

## Definition of Done
1. Кнопка "Вывести" отображается в настройках
2. Ввод адреса с валидацией (0x...)
3. Показ баланса
4. Кнопки процентов работают корректно
5. Вывод выполняется на указанный адрес
6. Нет синтаксических ошибок
7. Тесты проходят
