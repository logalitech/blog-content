#!/usr/bin/env node
// Validación del contenido del blog (es/, en/) y de las landings (landings/).
//
// Aplica las mismas reglas que la compilación de la web (Astro, repo
// web-frontend), de modo que el contenido que pasa esta validación no puede
// romper la publicación:
//   · cabecera YAML leída con js-yaml, igual que Astro;
//   · campos y tipos equivalentes al esquema de src/content.config.ts;
//   · cuerpo compilado con @mdx-js/mdx + remark-gfm + rehype-raw, igual que
//     @astrojs/mdx, incluida la conversión de los bloques ```mermaid;
//   · reglas del blog: categorías, componentes, Mermaid sin HTML, imágenes.
// Los errores bloquean la PR; los avisos solo se informan.
//
// Autónomo: sin secretos ni acceso a otros repositorios (el repo es público).
// Uso local:  npm ci --prefix scripts   (una sola vez)
//             node scripts/validate.mjs
import { readdir, readFile, access, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { compile, nodeTypes } from '@mdx-js/mdx';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const IN_CI = process.env.GITHUB_ACTIONS === 'true';

// Mismo patrón que @astrojs/markdown-remark (frontmatter.js).
const FRONTMATTER_RE = /(?:^\uFEFF?|^\s*\n)(?:---|\+\+\+)([\s\S]*?\n)(?:---|\+\+\+)/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const POST_FIELDS = ['title', 'description', 'pubDate', 'updatedDate', 'author', 'tags', 'category', 'heroImage', 'draft', 'lang', 'translationKey'];
const LANDING_FIELDS = ['title', 'description', 'kicker', 'headline', 'sub', 'bullets', 'form', 'testimonials', 'cta', 'showNav', 'utmCampaign', 'draft'];
// Componentes que la web pone a disposición del MDX (lp/[slug].astro).
const LANDING_COMPONENTS = new Set(['Video']);
const MERMAID_MAX_WORD = 36;
const MERMAID_TYPES = /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|gantt|pie|journey|mindmap|timeline|gitGraph|quadrantChart|requirementDiagram|C4\w*|sankey(-beta)?|xychart(-beta)?|block(-beta)?|packet(-beta)?|architecture(-beta)?|kanban|radar(-beta)?)\b/;

// ── Registro de incidencias ─────────────────────────────────────────────
const issues = [];
const add = (level) => (file, line, msg, hint = '') => issues.push({ level, file, line: line || 1, msg, hint });
const error = add('error');
const warning = add('warning');

// ── Utilidades ──────────────────────────────────────────────────────────
async function exists(rel) {
  try { await access(join(ROOT, rel)); return true; } catch { return false; }
}

async function listFiles(dir) {
  let entries = [];
  try { entries = await readdir(join(ROOT, dir), { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...(await listFiles(rel)));
    else if (/\.mdx?$/.test(e.name)) out.push(rel);
  }
  return out.sort();
}

function describe(v) {
  if (v === null) return 'un valor vacío';
  if (Array.isArray(v)) return 'una lista';
  if (v instanceof Date) return 'una fecha';
  if (typeof v === 'object') return 'un bloque de campos';
  if (typeof v === 'number') return 'un número';
  if (typeof v === 'boolean') return 'un valor true/false';
  return 'un texto';
}

const QUOTE_HINT = 'Escribe el texto entre comillas dobles. Si contiene «: » sin comillas, YAML lo interpreta como un bloque de campos.';

// ── Lectura de la cabecera ──────────────────────────────────────────────
function parseFile(file, code) {
  const m = FRONTMATTER_RE.exec(code);
  if (!m) {
    error(file, 1, 'falta la cabecera (bloque --- ... --- al principio del fichero)', 'La primera línea del fichero debe ser ---.');
    return null;
  }
  const raw = m[1];
  const openIdx = code.indexOf(m[0].includes('+++') ? '+++' : '---', m.index);
  const openLine = code.slice(0, openIdx).split('\n').length;
  const rawLines = raw.split('\n');
  const lineOf = (key) => {
    const i = rawLines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l));
    return i < 0 ? openLine : openLine + i;
  };
  // Cuerpo sin la cabecera, conservando los saltos de línea para que los
  // números de línea de los errores coincidan con el fichero.
  const body = code.slice(0, m.index) + m[0].replace(/[^\r\n]/g, '') + code.slice(m.index + m[0].length);
  let fm;
  try {
    fm = yaml.load(raw);
  } catch (e) {
    const line = openLine + (e.mark ? e.mark.line : 0);
    const tab = /tab/i.test(e.reason || '');
    error(file, line, `la cabecera no es YAML válido (${e.reason || e.message})`,
      tab ? 'Usa espacios para la sangría, nunca tabuladores.' : QUOTE_HINT);
    return { fm: null, body, lineOf };
  }
  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) {
    error(file, openLine, 'la cabecera está vacía o no contiene campos');
    return { fm: null, body, lineOf };
  }
  return { fm, body, lineOf };
}

// ── Comprobaciones de campos (equivalentes al esquema Zod de la web) ─────
function fieldChecker(file, fm, lineOf) {
  const at = (key) => lineOf(key);
  return {
    string(key, { required = false, nonEmpty = required } = {}) {
      const v = fm[key];
      if (v === undefined) { if (required) error(file, at(key), `falta el campo obligatorio «${key}»`); return; }
      if (typeof v !== 'string') { error(file, at(key), `«${key}» debe ser un texto y ahora es ${describe(v)}`, QUOTE_HINT); return; }
      if (nonEmpty && v.trim() === '') error(file, at(key), `el campo «${key}» está vacío`);
    },
    date(key, { required = false } = {}) {
      const v = fm[key];
      if (v === undefined) { if (required) error(file, at(key), `falta el campo obligatorio «${key}»`); return; }
      if (Number.isNaN(new Date(v).getTime())) { error(file, at(key), `«${key}» no es una fecha válida`, 'Formato AAAA-MM-DD, por ejemplo 2026-10-01.'); return; }
      if (typeof v === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(v.trim()))
        warning(file, at(key), `«${key}» no sigue el formato AAAA-MM-DD`, 'Escribe la fecha como 2026-10-01, sin comillas.');
    },
    boolean(key) {
      const v = fm[key];
      if (v !== undefined && typeof v !== 'boolean')
        error(file, at(key), `«${key}» debe ser true o false y ahora es ${describe(v)}`, 'Escribe true o false sin comillas.');
    },
    stringList(key) {
      const v = fm[key];
      if (v === undefined) return;
      if (!Array.isArray(v)) { error(file, at(key), `«${key}» debe ser una lista y ahora es ${describe(v)}`, 'Formato: ["Uno", "Dos"].'); return; }
      v.forEach((item, i) => {
        if (typeof item !== 'string')
          error(file, at(key), `el elemento ${i + 1} de «${key}» debe ser un texto y ahora es ${describe(item)}`, QUOTE_HINT);
      });
    },
    unknown(known, extra = {}) {
      for (const key of Object.keys(fm)) {
        if (known.includes(key)) continue;
        warning(file, at(key), extra[key] || `la web no utiliza el campo «${key}» (se ignora)`, 'Revisa si el nombre está bien escrito.');
      }
    },
  };
}

function checkPost(file, fm, lineOf, categories) {
  const c = fieldChecker(file, fm, lineOf);
  c.string('title', { required: true });
  c.string('description', { required: true });
  c.date('pubDate', { required: true });
  c.date('updatedDate');
  c.string('author');
  c.stringList('tags');
  c.string('heroImage');
  c.boolean('draft');
  c.string('translationKey', { required: true });
  c.unknown(POST_FIELDS);

  const folder = file.split('/')[0];
  if (fm.lang === undefined) error(file, lineOf('lang'), 'falta el campo obligatorio «lang»');
  else if (!['es', 'en'].includes(fm.lang)) error(file, lineOf('lang'), `«lang» debe ser "es" o "en" (ahora "${fm.lang}")`);
  else if (fm.lang !== folder) error(file, lineOf('lang'), `lang="${fm.lang}" no coincide con la carpeta «${folder}/»`, 'Corrige «lang» o mueve el fichero a la carpeta correcta.');

  if (fm.category === undefined) error(file, lineOf('category'), 'falta el campo obligatorio «category»', 'Elige una categoría de categories.json.');
  else if (typeof fm.category !== 'string' || !categories.includes(fm.category))
    error(file, lineOf('category'), `la categoría "${fm.category}" no está en categories.json`, 'Cópiala con la grafía exacta de la lista (mayúsculas y espacios incluidos).');
}

function checkLanding(file, fm, lineOf) {
  const c = fieldChecker(file, fm, lineOf);
  c.string('title', { required: true });
  c.string('description', { required: true });
  c.string('kicker');
  c.string('headline');
  c.string('sub');
  c.stringList('bullets');
  c.boolean('showNav');
  c.boolean('draft');
  c.string('utmCampaign', { nonEmpty: false });
  if (typeof fm.utmCampaign === 'string' && fm.utmCampaign !== '' && !/^[0-9]{6}-[a-z0-9-]+$/.test(fm.utmCampaign))
    error(file, lineOf('utmCampaign'), `utmCampaign="${fm.utmCampaign}" no sigue el formato AAAAMM-nombre`, 'Ejemplo: 202610-webinar-rap.');

  const obj = (key) => fm[key] !== undefined && (fm[key] === null || typeof fm[key] !== 'object' || Array.isArray(fm[key]));
  if (obj('form')) error(file, lineOf('form'), `«form» debe ser un bloque de campos y ahora es ${describe(fm.form)}`);
  else if (fm.form) {
    for (const k of ['heading', 'button', 'source'])
      if (fm.form[k] !== undefined && typeof fm.form[k] !== 'string') error(file, lineOf('form'), `«form.${k}» debe ser un texto`, QUOTE_HINT);
    if (fm.form.enabled !== undefined && typeof fm.form.enabled !== 'boolean') error(file, lineOf('form'), '«form.enabled» debe ser true o false');
  }
  if (fm.testimonials !== undefined) {
    if (!Array.isArray(fm.testimonials)) error(file, lineOf('testimonials'), `«testimonials» debe ser una lista y ahora es ${describe(fm.testimonials)}`);
    else fm.testimonials.forEach((t, i) => {
      if (!t || typeof t !== 'object') { error(file, lineOf('testimonials'), `el testimonio ${i + 1} no tiene el formato esperado`); return; }
      for (const k of ['quote', 'author'])
        if (typeof t[k] !== 'string') error(file, lineOf('testimonials'), `el testimonio ${i + 1} necesita «${k}» como texto`, QUOTE_HINT);
      if (t.role !== undefined && typeof t.role !== 'string') error(file, lineOf('testimonials'), `«role» del testimonio ${i + 1} debe ser un texto`, QUOTE_HINT);
    });
  }
  if (fm.cta !== undefined && fm.cta !== null) {
    if (typeof fm.cta !== 'object' || Array.isArray(fm.cta)) error(file, lineOf('cta'), `«cta» debe ser un bloque de campos y ahora es ${describe(fm.cta)}`);
    else for (const k of ['label', 'href'])
      if (fm.cta[k] !== undefined && typeof fm.cta[k] !== 'string') error(file, lineOf('cta'), `«cta.${k}» debe ser un texto`, QUOTE_HINT);
  }
  c.unknown(LANDING_FIELDS, {
    noindex: 'la web no utiliza «noindex»: las landings son siempre noindex y quedan fuera del sitemap',
  });
}

// ── Cuerpo MDX ──────────────────────────────────────────────────────────
// Réplica exacta del plugin de astro.config.mjs (web-frontend).
function remarkMermaid() {
  const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const walk = (node) => {
    if (!node || !Array.isArray(node.children)) return;
    for (const child of node.children) {
      if (child.type === 'code' && child.lang === 'mermaid') {
        child.type = 'html';
        child.value = `<pre class="mermaid" data-mermaid="${escape(child.value)}">${escape(child.value)}</pre>`;
      } else {
        walk(child);
      }
    }
  };
  return (tree) => walk(tree);
}

function walkTree(node, fn) {
  fn(node);
  if (Array.isArray(node.children)) for (const child of node.children) walkTree(child, fn);
}

// Revisa el árbol MDX antes de la conversión de Mermaid.
function remarkInspect(ctx) {
  return (tree) => {
    let dashReported = false;
    walkTree(tree, (node) => {
      const line = node.position?.start?.line;
      switch (node.type) {
        case 'mdxjsEsm':
          error(ctx.file, line, 'línea con import/export fuera de un bloque de código', 'Reformula la frase o inclúyela en un bloque de código.');
          break;
        case 'mdxJsxFlowElement':
        case 'mdxJsxTextElement': {
          const name = node.name || '';
          if (/^[A-Z]/.test(name) || name.includes('.')) {
            if (!(ctx.kind === 'landing' && LANDING_COMPONENTS.has(name)))
              error(ctx.file, line, `el componente <${name}> no está disponible en ${ctx.kind === 'landing' ? 'las landings' : 'los artículos'}`,
                ctx.kind === 'landing' ? 'Solo se admite <Video />.' : 'Los artículos solo admiten Markdown y HTML estándar.');
          }
          if (name === 'img') {
            const src = (node.attributes || []).find((a) => a.name === 'src')?.value;
            if (typeof src === 'string') ctx.images.push({ url: src, line });
          }
          break;
        }
        case 'mdxFlowExpression':
        case 'mdxTextExpression': {
          const code = String(node.value || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').trim();
          if (code !== '' && !/^(["'`])[\s\S]*\1$/.test(code))
            error(ctx.file, line, `llaves { } en el texto: MDX las interpreta como código («{${String(node.value).slice(0, 40)}}»)`,
              'Escribe las llaves como código entre comillas invertidas o escápalas: \\{ \\}.');
          break;
        }
        case 'heading':
          if (node.depth === 1 && ctx.kind === 'post')
            warning(ctx.file, line, 'encabezado # en el cuerpo: el título ya se muestra como encabezado principal', 'Usa ## para las secciones.');
          break;
        case 'code':
          if (node.lang === 'mermaid') {
            const src = String(node.value || '');
            if (/<\/?[a-zA-Z][^>]*>/.test(src))
              error(ctx.file, line, 'HTML dentro del diagrama Mermaid (por ejemplo <br/>): la web lo dibuja en modo seguro y lo rechaza',
                'Quita las etiquetas HTML; si un texto es largo, divídelo en varios nodos.');
            const first = src.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('%%')) || '';
            if (!MERMAID_TYPES.test(first))
              warning(ctx.file, line, `el diagrama Mermaid no empieza por un tipo conocido («${first.slice(0, 30)}»)`, 'La primera línea debe ser, por ejemplo, flowchart TB.');
            // La web parte las etiquetas por los espacios a partir de unos 44
            // caracteres; una palabra sin espacios más larga que eso se recorta.
            for (const [, label] of src.matchAll(/"([^"\n]*)"/g)) {
              const word = label.split(/\s+/).find((w) => [...w].length > MERMAID_MAX_WORD);
              if (word)
                warning(ctx.file, line, `la etiqueta Mermaid «${label.slice(0, 50)}» tiene una palabra de ${[...word].length} caracteres sin espacios: se mostrará recortada`,
                  `Acórtala a ${MERMAID_MAX_WORD} caracteres como máximo o divídela en dos nodos.`);
            }
          }
          break;
        case 'image':
          ctx.images.push({ url: node.url, line });
          break;
        case 'link':
          ctx.links.push({ url: node.url, line });
          break;
        case 'text':
          if (!dashReported && /[\u2013\u2014]/.test(node.value || '')) {
            dashReported = true;
            warning(ctx.file, line, 'el texto contiene rayas (raya larga o semirraya)', 'Sustitúyelas por comas, dos puntos, punto y coma o paréntesis.');
          }
          break;
      }
    });
  };
}

function explainMdx(e) {
  const reason = String(e.reason || e.message || '');
  const source = String(e.source || '');
  if (/`!`/.test(reason) && /before name/.test(reason))
    return ['comentario HTML <!-- ... --> no admitido en MDX', 'Usa {/* comentario */} o elimina el comentario.'];
  const closing = reason.match(/Expected a closing tag for `<([^>]+)>`/);
  if (closing)
    return [`etiqueta <${closing[1]}> sin cerrar`, 'Ciérrala (por ejemplo <br />) o escribe el texto como código entre comillas invertidas.'];
  if (/closing tag/i.test(reason))
    return ['etiqueta HTML de cierre sin su apertura correspondiente', 'Revisa que cada etiqueta abierta se cierre en el orden correcto.'];
  if (/jsx/.test(source) || /before name|after name|attribute/.test(reason))
    return ['signo < interpretado como etiqueta HTML', 'Escribe el texto como código entre comillas invertidas (por ejemplo `a<b`) o usa &lt;. Los enlaces <https://...> no se admiten: usa [texto](https://...).'];
  if (/expression|acorn/i.test(source + reason))
    return ['llaves { } interpretadas como código', 'Escribe las llaves como código entre comillas invertidas o escápalas: \\{ \\}.'];
  if (/esm|import|export/i.test(source + reason))
    return ['línea con import/export fuera de un bloque de código', 'Reformula la frase o inclúyela en un bloque de código.'];
  return [`error de sintaxis MDX (${reason})`, 'Revisa la línea indicada.'];
}

async function checkBody(ctx, body) {
  if (!ctx.file.endsWith('.mdx')) return;
  try {
    await compile({ path: ctx.file, value: body }, {
      format: 'mdx',
      jsxImportSource: 'astro',
      elementAttributeNameCase: 'html',
      remarkPlugins: [remarkGfm, [remarkInspect, ctx], remarkMermaid],
      rehypePlugins: [[rehypeRaw, { passThrough: nodeTypes }]],
    });
  } catch (e) {
    const [msg, hint] = explainMdx(e);
    error(ctx.file, e.line || e.place?.line || e.place?.start?.line, msg, hint);
  }
}

// ── Salida ──────────────────────────────────────────────────────────────
const escData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => escData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
// Celdas de la tabla del informe: se escapa el HTML para que GitHub no oculte
// fragmentos como los comentarios de ejemplo.
const cell = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '\\|').replace(/\n/g, ' ');

async function report(nPosts, nLandings) {
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');
  issues.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1) || a.file.localeCompare(b.file) || a.line - b.line);

  for (const i of issues) {
    const mark = i.level === 'error' ? '✗ ERROR' : '⚠ AVISO';
    console.log(`${mark}  ${i.file}:${i.line}  ${i.msg}${i.hint ? `\n          → ${i.hint}` : ''}`);
    if (IN_CI) console.log(`::${i.level} file=${escProp(i.file)},line=${i.line},title=${escProp('Validación del contenido')}::${escData(i.msg + (i.hint ? `. ${i.hint}` : ''))}`);
  }
  const verdict = errors.length
    ? `❌ Validación fallida: ${errors.length} error(es) y ${warnings.length} aviso(s) en ${nPosts} artículo(s) y ${nLandings} landing(s).`
    : `✅ ${nPosts} artículo(s) y ${nLandings} landing(s) validados: 0 errores, ${warnings.length} aviso(s).`;
  console.log(`\n${verdict}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = issues.map((i) => `| ${i.level === 'error' ? '❌ Error' : '⚠️ Aviso'} | \`${cell(i.file)}\` | ${i.line} | ${cell(i.msg)} | ${cell(i.hint)} |`);
    const md = [
      '## Validación del contenido',
      '',
      verdict,
      '',
      errors.length ? 'Los **errores** impiden fusionar la PR: corrígelos en la línea indicada y guarda de nuevo. Los avisos no bloquean.' : '',
      '',
      ...(rows.length ? ['| Tipo | Fichero | Línea | Problema | Cómo corregirlo |', '|---|---|---|---|---|', ...rows] : []),
      '',
    ].join('\n');
    await appendFile(process.env.GITHUB_STEP_SUMMARY, md);
  }
  return errors.length === 0;
}

// ── Programa principal ──────────────────────────────────────────────────
let categories = [];
try {
  categories = JSON.parse(await readFile(join(ROOT, 'categories.json'), 'utf8'));
  if (!Array.isArray(categories) || categories.some((c) => typeof c !== 'string')) throw new Error('formato');
} catch {
  error('categories.json', 1, 'categories.json no se puede leer o no es una lista de textos', 'Formato: ["Categoría 1", "Categoría 2"].');
  categories = [];
}
// Las categorías nuevas se fusionan solas: la lista debe quedar limpia.
categories.forEach((c, i) => {
  if (c.trim() === '' || c !== c.trim() || /\s{2}/.test(c))
    error('categories.json', i + 2, `la categoría «${c}» está vacía o tiene espacios sobrantes`, 'Quita los espacios al principio, al final o duplicados.');
  else if (categories.findIndex((x) => x.toLowerCase() === c.toLowerCase()) !== i)
    error('categories.json', i + 2, `la categoría «${c}» está repetida`, 'Cada categoría aparece una sola vez; usa la que ya existe.');
});

const postFiles = [...(await listFiles('es')), ...(await listFiles('en'))];
const landingFiles = await listFiles('landings');
if (postFiles.length === 0) error('es', 1, 'no se ha encontrado ningún artículo en es/ ni en/');

const published = { es: new Map(), en: new Map() }; // slug → draft
const pendingLinks = [];
const translationKeys = new Map(); // lang|key → ficheros publicados
const seriesDates = new Map(); // lang|categoría|pubDate → ficheros publicados

for (const file of [...postFiles, ...landingFiles]) {
  const kind = file.startsWith('landings/') ? 'landing' : 'post';
  const code = (await readFile(join(ROOT, file), 'utf8')).replace(/^\uFEFF/, '');
  const slug = file.split('/').pop().replace(/\.mdx?$/, '');
  if (!SLUG_RE.test(slug)) {
    const msg = `el nombre del fichero «${slug}» no es una dirección web limpia`;
    const hint = 'Usa minúsculas, sin tildes, eñes ni espacios, con palabras separadas por guiones.';
    if (kind === 'post') error(file, 1, msg, hint); else warning(file, 1, msg, hint);
  }

  const parsed = parseFile(file, code);
  if (!parsed) continue;
  const { fm, body, lineOf } = parsed;

  if (fm) {
    if (kind === 'post') {
      checkPost(file, fm, lineOf, categories);
      const lang = file.split('/')[0];
      if (published[lang]) published[lang].set(slug, fm.draft === true);
      if (fm.draft !== true && typeof fm.translationKey === 'string') {
        const k = `${lang}|${fm.translationKey}`;
        translationKeys.set(k, [...(translationKeys.get(k) || []), file]);
      }
      if (fm.draft !== true && typeof fm.category === 'string' && fm.pubDate instanceof Date) {
        const k = `${lang}|${fm.category}|${fm.pubDate.toISOString().slice(0, 10)}`;
        seriesDates.set(k, [...(seriesDates.get(k) || []), file]);
      }
    } else {
      checkLanding(file, fm, lineOf);
    }
  }

  const ctx = { file, kind, images: [], links: [] };
  await checkBody(ctx, body);

  const heroImage = fm && typeof fm.heroImage === 'string' ? fm.heroImage : null;
  const images = [...ctx.images, ...(heroImage ? [{ url: heroImage, line: lineOf('heroImage') }] : [])];
  for (const img of images) {
    const m = String(img.url).match(/^\/images\/blog\/([^?#]+)/);
    if (m && !(await exists(`images/${decodeURIComponent(m[1])}`)))
      error(file, img.line, `la imagen ${img.url} no existe en la carpeta images/`, 'Sube la imagen a images/ y enlázala como /images/blog/<nombre>.');
  }
  for (const l of ctx.links) pendingLinks.push({ file, ...l });
}

// Enlaces internos a artículos del blog.
for (const l of pendingLinks) {
  const m = String(l.url).match(/^\/(en\/)?blog\/([^/?#]+)\/?(?:[?#].*)?$/);
  if (!m || ['categoria', 'category'].includes(m[2])) continue;
  const lang = m[1] ? 'en' : 'es';
  const target = published[lang].get(m[2]);
  if (target === undefined)
    warning(l.file, l.line, `el enlace ${l.url} apunta a un artículo que no existe`, 'Revisa el slug del artículo enlazado.');
  else if (target === true)
    warning(l.file, l.line, `el enlace ${l.url} apunta a un artículo en borrador (draft: true)`, 'El enlace no funcionará hasta que ese artículo se publique.');
}

for (const [k, files] of translationKeys) {
  if (files.length > 1)
    warning(files[1], 1, `translationKey "${k.split('|')[1]}" repetido en ${files.join(' y ')}`, 'Cada artículo necesita una clave propia, compartida solo con su traducción.');
}

for (const [k, files] of seriesDates) {
  const [, cat, date] = k.split('|');
  if (files.length > 1)
    warning(files[1], 1, `${files.join(' y ')} comparten pubDate ${date} en la serie «${cat}»: la web los ordena por translationKey`,
      'Si importa el orden de la serie, usa fechas distintas (pubDate es la fecha real de publicación).');
}

const ok = await report(postFiles.length, landingFiles.length);
process.exit(ok ? 0 : 1);
