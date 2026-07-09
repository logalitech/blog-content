# blog-content

Contenido del blog de Logali Tech (posts MDX). **Separado del código** de la web
(`logalitech/web-frontend`), que lo consume como submódulo en `src/content/blog`.

Así, editores y agentes escriben aquí sin tocar el repo de código, y un post con
un error **no puede tumbar ni bloquear** la web (se valida en el PR y, aunque se
colara, el build fallido nunca llega a producción).

## Estructura

```
es/<slug>.mdx      posts en español  → /blog/<slug>/
en/<slug>.mdx      posts en inglés   → /en/blog/<slug>/
```

El esquema de cada post (frontmatter) y el procedimiento completo (categorías,
imágenes, diagramas Mermaid) están en el repo `web-frontend`:
`docs/BLOG_CONTENT_CONTRACT.md` y `docs/PROCEDIMIENTO_BLOG.md`.

## Cómo se publica

1. Se crea/edita un `.mdx` en una rama y se abre un **PR** (a mano, con Decap en
   `cms.logalitech.com`, o por el agente A1).
2. El workflow **Validate content** construye el sitio real con el post → si algo
   falla, el check sale en rojo y no se puede mergear.
3. **Merge a `main` = publicación**: la web detecta el contenido nuevo y lo
   despliega automáticamente (sin downtime; no afecta a la tienda WooCommerce).
