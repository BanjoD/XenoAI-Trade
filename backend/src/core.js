// XenoAI Trade — СЕРВЕР: общий агрегатор ядра (движок + форматтеры + данные).
// Единая точка импорта для account.js и room.js: сервер использует ТЕ ЖЕ модули,
// что и браузер (vendor-копии собраны из js/ без изменений).
"use strict";

import { Engine } from "./engine.js";
import { DataLib } from "./vendor/data.js";
import { Fmt } from "./vendor/format.js";

export { Engine, DataLib, Fmt };
