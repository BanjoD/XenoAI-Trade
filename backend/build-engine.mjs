// Сборка backend/src/engine.js: тело IIFE движка извлекается из js/engine.js
// программно — перенос идёт байт-в-байт, без ручной транскрипции.
import { readFileSync, writeFileSync } from "node:fs";

const src = readFileSync(new URL("../js/engine.js", import.meta.url), "utf8");
const start = src.indexOf("const Engine = (() => {");
const end = src.lastIndexOf("})();");
if (start < 0 || end < 0) throw new Error("не найдены границы IIFE Engine");
const body = src.slice(start + "const Engine = (() => {".length, end);

const out = `// XenoAI Trade — движок (СЕРВЕР): автоматически собран из js/engine.js (build-engine.mjs).
// Байт-в-байт то же ядро, что у браузера и Стража: стратегии, политика выходов
// «тело + N%», ансамбль 13 факторов, трейлинг, обучение. Идентичность гарантирует
// паритет-тест (scripts/test-backend.js): оба движка обязаны давать одинаковые вердикты.
import { Ind } from "./vendor/indicators.js";
import { DataLib } from "./vendor/data.js";
import { Fmt } from "./vendor/format.js"; // движок не использует Fmt, но держим паритет зависимостей

export const Engine = (() => {
${body}
})();

export default Engine;
`;

writeFileSync(new URL("./src/engine.js", import.meta.url), out);
console.log("backend/src/engine.js собран:", body.length, "символов тела");
