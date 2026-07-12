#!/usr/bin/env node
// Validación autónoma del contenido (sin dependencias, sin acceso a web-frontend).
// Puerta de calidad del PR: caza los errores de autoría más comunes antes de
// mergear. La correctitud final (render MDX) la garantiza el build del deploy,
// que nunca publica si algo falla → el sitio en vivo queda intacto igualmente.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const LANGS = ['es', 'en'];
const REQUIRED = ['title', 'description', 'pubDate', 'lang', 'translationKey', 'category'];
const errors = [];

// Lista maestra de categorías (misma fuente que consume la web).
let CATEGORIES = [];
try {
  CATEGORIES = JSON.parse(await readFile('categories.json', 'utf8'));
} catch {
  errors.push('No se pudo leer categories.json (lista de categorías).');
}

async function mdxFiles(dir) {
  let out = [];
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out = out.concat(await mdxFiles(p));
    else if (e.name.endsWith('.mdx') || e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

// Parser mínimo del frontmatter YAML (clave: valor + listas [..]). Suficiente
// para el esquema controlado del blog; no pretende ser un parser YAML completo.
function parseFrontmatter(raw, file) {
  const m = raw.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) { errors.push(`${file}: falta el bloque de frontmatter (--- ... ---)`); return null; }
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) continue;
    let [, k, v] = kv;
    v = v.trim().replace(/^["']|["']$/g, '');
    data[k] = v;
  }
  return data;
}

const files = (await Promise.all(LANGS.map((l) => mdxFiles(l)))).flat();
if (files.length === 0) errors.push('No se encontró ningún post en es/ ni en/.');

for (const file of files) {
  const raw = await readFile(file, 'utf8');
  const fm = parseFrontmatter(raw, file);
  if (!fm) continue;
  for (const key of REQUIRED) {
    if (!(key in fm) || fm[key] === '') errors.push(`${file}: falta el campo obligatorio "${key}"`);
  }
  const folderLang = file.split(/[\\/]/)[0];
  if (fm.lang && fm.lang !== folderLang)
    errors.push(`${file}: lang="${fm.lang}" no coincide con la carpeta "${folderLang}/"`);
  if (fm.pubDate && Number.isNaN(Date.parse(fm.pubDate)))
    errors.push(`${file}: pubDate="${fm.pubDate}" no es una fecha válida (usa YYYY-MM-DD)`);
  if (fm.category && CATEGORIES.length && !CATEGORIES.includes(fm.category))
    errors.push(`${file}: category="${fm.category}" no está en categories.json`);
}

// Landings de campaña (landings/ → /lp/<slug>/). Esquema propio, mucho más
// laxo que el blog: solo exigimos lo que rompería la página o la analítica.
const landingFiles = await mdxFiles('landings');
for (const file of landingFiles) {
  const raw = await readFile(file, 'utf8');
  const fm = parseFrontmatter(raw, file);
  if (!fm) continue;
  for (const key of ['title', 'description']) {
    if (!(key in fm) || fm[key] === '') errors.push(`${file}: falta el campo obligatorio "${key}"`);
  }
  if (fm.utmCampaign && !/^[0-9]{6}-[a-z0-9-]+$/.test(fm.utmCampaign))
    errors.push(`${file}: utmCampaign="${fm.utmCampaign}" no sigue el formato AAAAMM-nombre`);
}

if (errors.length) {
  console.error('❌ Validación de contenido fallida:\n' + errors.map((e) => '  · ' + e).join('\n'));
  process.exit(1);
}
console.log(`✅ ${files.length} post(s) y ${landingFiles.length} landing(s) validados correctamente.`);
