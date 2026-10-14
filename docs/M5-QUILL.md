# Quill — Markdown document view

M5, [PR #21](https://github.com/ImJstNickDev/nickhosting-panel/pull/21),
part of [ViewerEngine](M5-VIEWER-FORMATS.md) and
[ADR 0017](decisions/0017-shared-file-viewers.md).

Quill opens `.md`, `.markdown`, `.mdown` and `.mkd` documents through Fileman.
Its toolbar switches to Scribe without downloading again. Both views share the
exact source, unsaved changes, undo history, save revision and source position.
Rendering never modifies a file. Task-list clicks change the shared draft and
require the existing explicit save action. Included documents and archive members
cannot be edited through the preview.

## Supported document syntax

| Feature | Contract |
| --- | --- |
| CommonMark / GFM | Headings, paragraphs, emphasis, links, images, code, tables, task lists, strikethrough, autolinks and footnotes. |
| Math | Inline `$...$`, block `$$...$$` and fenced `math`; KaTeX with chemistry `\ce{H2O}`. Supported KaTeX commands, not arbitrary TeX packages or `.tex` documents. |
| Callouts | GitHub `> [!NOTE]`, TIP, IMPORTANT, WARNING, CAUTION; Obsidian-style titles and `+`/`-` folding. |
| Restricted HTML | Sanitized formatting, tables, `<kbd>`, `<sup>`, `<sub>`, `<details>/<summary>`, image dimensions. Scripts, styles, frames, forms, handlers and executable URLs are removed. |
| Code | Syntax highlighting for bundled common languages; unknown languages stay readable. Fence metadata `title="server.json"`, `showLineNumbers`, `{2,4-6}`; copy preserves code text. |
| Navigation | Heading outline, local anchors, rendered-text search with CTRL/CMD+F, position handoff to/from Scribe, print layout. |
| Metadata | YAML `---` and TOML `+++` frontmatter, shown on demand. No remote schema lookup or executable values. |
| Extra inline syntax | Emoji shortcodes, `==highlight==`, `H~2~O`, `x^2^`, and definition lists. These are documented extensions, not CommonMark syntax. |
| Diagrams | Fenced `mermaid`, loaded near the viewport; source remains inspectable. Strict configuration, no document-supplied initialization directives/frontmatter configuration or active links. |
| Wiki links | `[[Note]]`, `[[folder/Note]]`, `[[Note#Heading]]`, `[[Note#^block-id]]`, `[[Note|label]]`. Explicit relative paths also work. |
| Inclusions | `![[Note]]`, heading/block subsets and local image inclusions; other local assets can be opened in their appropriate viewer. Recursive cycles and excessive inclusion work stop locally. |
| References | `[@key]` with local BibTeX or CSL-JSON supplied by `bibliography: refs.bib` or inline CSL-JSON `references` metadata. `citation-style: numeric` selects numbering; otherwise basic author/year labels. |

Custom directive blocks (`:::note`, custom tabs) are **not implemented**, following
the Owner's explicit exclusion. Citations do not claim full APA, arbitrary CSL,
Pandoc bibliography processing or automatic DOI/network resolution. Unknown
references remain visible rather than being invented. No Obsidian plugins,
Dataview queries, JavaScript blocks or executable MDX are supported.

## Wiki paths and resource access

The current folder is checked first for an unqualified wiki name, including `.md`
and `.markdown` extension fallback. Previously indexed Fileman metadata supplies
additional candidates. Multiple matches are ambiguous; an explicit path resolves
them. There is no automatic recursive vault/server scan. Standard relative links
use the containing document's directory, including inside an included note.
Archive links resolve within the current archive/nested-container namespace and
cannot traverse into host paths. A missing heading or file is not silently
replaced with a different document.

Local reads use same-origin, already-authorized viewer endpoints. Existing
server/session permissions, resource identity, broker caching and revocation still
apply. No provider tokens appear in the document or browser. The document resource
cache exists only for the mounted document, not persistent browser storage.
External HTTPS/HTTP images load only after an explicit click and send no referrer;
external links open separately with `noopener noreferrer`.

## Bounds and dependencies

- Main document and each text resource: 1 MiB, matching the shared editor budget.
- Text resource cache: at most 4 MiB and 32 entries; concurrent reads deduplicate,
  and one cancelled consumer does not abort another. At most eight active reads
  and 32 total pending reads; excess admitted reads wait in a bounded queue.
- Parser: 50,000 initial nodes, 128 levels, 64 KiB frontmatter, 2,000 references;
  generated KaTeX output is also bounded. Worker deadlines terminate pathological
  work instead of blocking the application thread.
- Includes: at most three levels with aggregate occurrence, source-byte and
  rendered-node budgets; cycles are rejected. These limits concern embedded
  previews, not the ability to open a note separately.
- Bibliographies: 512 KiB, 1,000 entries, isolated five-second parsing deadline;
  lazy worker module startup has its own 20-second deadline.
- Mermaid: 32 KiB source and 200 edges; lazy diagram modules, inert image output.
  Large diagrams are not a guarantee of acceptable arbitrary graph-layout cost.

Pinned direct dependencies are recorded in `apps/web/package.json` and the lockfile.
The unified/remark/rehype components, KaTeX, Mermaid, Citation.js core/BibTeX and
parse5/HAST conversion are MIT-licensed. Highlight.js is BSD-3-Clause. Existing
YAML/TOML parsers are reused. The citeproc-based CSL plugin was deliberately not
retained because its dependency introduces CPAL/AGPL licensing obligations; no
repository licensing decision is made by this feature. No upstream application
source was copied into NickHosting.

Reference contracts: [CommonMark](https://spec.commonmark.org/),
[remark-gfm](https://github.com/remarkjs/remark-gfm),
[KaTeX supported commands](https://katex.org/docs/supported.html),
[KaTeX security](https://katex.org/docs/security),
[rehype sanitation](https://github.com/rehypejs/rehype-sanitize),
[Mermaid configuration](https://mermaid.js.org/config/usage),
[Obsidian links](https://help.obsidian.md/links),
[Citation.js](https://github.com/citation-js/citation-js).

## Verification boundary

Focused unit and browser evidence is recorded in [M5 validation](M5-VALIDATION.md).
Browser journeys use the real application and isolated authentication/file-edit
handlers, with external provider bytes supplied by test fixtures. No production
server files are created or modified. Development dependency activation is a
separate, explicitly approved Vite image update. SFTPGo issue #18 remains unchanged.


Development Vite discovers the Markdown workers during its initial dependency
scan. Mermaid uses its upstream prebuilt split ESM distribution in development to
avoid rebundling its large layout graph within the fixed container memory budget.
The compiled production build retains the normal package entry. This packaging
choice does not alter diagram security settings or enable external resources.
