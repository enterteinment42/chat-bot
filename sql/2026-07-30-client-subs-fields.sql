-- Мини-CRM: контакт клиента, аккаунт продавца на Авито, логин аккаунта подписки.
-- Раньше всё это жило свободным текстом в note, откуда извлечение зависело от LLM.
-- Гранты не нужны: права на client_subs выданы на уровне таблицы, новые колонки их наследуют.
alter table client_subs
  add column if not exists contact        text,
  add column if not exists seller_account text,
  add column if not exists account_login  text;
