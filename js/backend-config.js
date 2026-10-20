// XenoAI Trade — конфиг бэкенда. URL заполняется АВТОМАТИЧЕСКИ деплой-воркфлоу
// (.github/workflows/deploy-backend.yml) сразу после первого успешного деплоя воркера:
// он коммитит сюда https://xenoai-trade-backend.<ваш-поддомен>.workers.dev
// Пустая строка = бэкенд не задеплоен, платформа живёт по старой схеме (локально + textdb).
"use strict";

window.XENOAI_BACKEND = {
  url: "",
  build: "r32",
};
