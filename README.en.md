# dsh-comfyui-link

[![CI](https://github.com/jx70/dsh-comfyui-link/actions/workflows/ci.yml/badge.svg)](https://github.com/jx70/dsh-comfyui-link/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.0--rc.1-blueviolet.svg)](https://github.com/deepseek-ai/deepseek-harness)

Drive your own ComfyUI from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): write prompts, tweak parameters, build workflows, submit jobs, and pull the resulting images back for the model to look at. It can also designate a **review model** that inspects each render and automatically re-draws it when the result doesn't meet the requirement.

> 中文说明见 [README.md](./README.md)

**Contents** · [The problem](#the-problem) · [Features](#features) · [Tools](#tools) · [Draw mode](#draw-mode) · [Requirements](#requirements) · [Install](#install) · [Usage](#usage) · [Settings page](#settings-page) · [LoRA prompt documents](#lora-prompt-documents) · [Configuration](#configuration) · [How it works](#how-it-works) · [Desktop](#desktop) · [Compatibility](#compatibility-and-known-limits) · [FAQ](#faq) · [Development](#development) · [Gotchas](#gotchas)

## The problem

A model can write a prompt, but it can't see the picture. So a human ends up doing three things every time: paste the prompt into ComfyUI, wait for the render, drag the image back for the model to look at. If it's wrong, start over.

This plugin turns that loop into tools: the model submits the job itself, waits for the result itself, looks at the image itself — and when it isn't satisfied, it re-renders from the review model's feedback. No human in the middle.

## Features

- **Ten tools** covering everything from liveness checks to image output — the model never needs to know ComfyUI's HTTP API.
- **Review loop**: after a render, the designated vision model judges it; if unsatisfied, the plugin re-renders from its suggested prompt until the result passes or the attempt limit is hit. Pass a reference image to compare character fidelity.
- **A built-in Draw mode**: alongside Standard / Minimal / PTC / Create there is a `draw` preset whose session starts as a rendering assistant, with an image-model picker and a LoRA toggle at the left of the composer (invisible in every other mode).
- **Draft-then-save settings**: address, review model, the img2img / upscale switches, and the image output directory are edited locally as a draft and written to the profile only when you press **Save**; no DSH restart needed once written.
- **Configurable output directory**: leave it empty and images stay only in ComfyUI own `output/`; point it at a directory and every fetch is also copied there (existing files are never overwritten — a suffix is appended). A single call can override it with `save_to`, and the directory is chosen with a **Pick** button that opens the native folder dialog — there is no path text box.
- **No host internals**: `lib/comfy.mjs` uses nothing but Node's built-in `fetch` and imports no `@deepseek-ai/*`, so it runs standalone (`npm run selftest` does exactly that).
- **Graph mode takes over any workflow**: export a workflow from ComfyUI in API format, hand it over, and the prompt and seed are still editable.
- **One package for Web and Desktop**: the Desktop (Electron) page is served from `dsh-app://app/`, so the plugin probes for the preload bridges (`__DSH_TRANSPORT__`, `__DSH_DIRECTORY_PICKER__`) and falls back to the ordinary browser path when they are absent.
- **LoRA prompt documents**: pick a directory in the settings page, one document per LoRA. When a LoRA is attached, the matching document's prompt section is folded into `prompt` automatically and the result says which file was used. Leave the directory empty and not a single file is read.
- **Verifiable**: 121 unit tests plus 7 probe scripts, none of which need you to click anything.

## Tools

Ten tools become available to the model:

| Tool | What it does |
| --- | --- |
| `comfy_status` | Is the server alive, how much VRAM is free, what's queued, how the recent jobs went |
| `comfy_models` | Which model files exist (`diffusion_models` / `text_encoders` / `vae` / `checkpoints` / `loras`). It opens with the **current draw config** (which image model is in use, whether LoRA may be attached, whether a prompt-doc folder is configured), and each LoRA line carries the **character aliases** recognised from the doc next to it |
| `comfy_node` | Inspect a node class: accepted inputs, defaults, ranges, enum values |
| `comfy_run` | Submit a job — `mode="template"` txt2img (optionally with a LoRA), `mode="img2img"`, or `mode="graph"` with your own API-format workflow. `lora: "auto"` picks one by the character name in `prompt` |
| `comfy_result` | Wait for the job, fetch the output images, actually show them to the model, report on-disk paths, optionally `save_to` |
| `comfy_control` | Cancel a job / interrupt the running one / clear the queue / free VRAM |
| `comfy_review` | **Review-and-redraw**: let the designated model judge the image and re-render from its suggested prompt until it's satisfied or the attempt limit is hit. Pass `reference_prompt_id` to check character fidelity, and `save_to` to keep a copy |
| `comfy_upscale` | Algorithmic upscale (`ImageScale`, lanczos by default) of an already generated image, with optional `save_to` |
| `comfy_lora_doc` | Look inside the LoRA prompt directory: pass `lora` for the matching document's tag blocks and negative block (add `prompt` to preview the pick by the outfit you named; `rest: true` for the outfits left out, `full: true` for the whole file), omit it to list everything. It never throws — it just explains the situation |
| `comfy_inspect` | **Workflow inspector**: read a workflow JSON (`graph` object or `path` file, API or UI format), identify Checkpoint / three-file loaders / LoRA / sampler / prompt / dimensions / ControlNet / output nodes, build the connections, list parameters the agent can change, and diagnose duplicate IDs / dangling links / out-of-range slots / type mismatches / missing required inputs. UI-format widget values are stored by position and unreliable, so they are shown as names only and never bound to values — use Save (API Format) to edit precisely. Subgraphs report only boundaries and node counts, not internals |

### Workflow inspector (`comfy_inspect`)

Given a workflow JSON, call `comfy_inspect` to see its structure before acting. Three layers:

- **Format adapter** (`lib/format-adapter.mjs`): recognises API format `{ "1": { class_type, inputs } }` and UI format `{ nodes, links }`. UI is editor state: its link data (top-level links table + node inputs/outputs) is reliable and converted into an API-shaped graph; widget values are stored **by position only** and are **never** bound to parameter names by position — it shows the parameter names and the raw `widgets_values`, and tells you to Save (API Format) for precise edits.
- **Semantic core** (`lib/inspector.mjs`): pure functions, API graph only, zero network and zero UI knowledge. Labels nodes, builds edges, lists editable parameters (all `confidence: exact`), and emits diagnostics. A source assertion pins that `widgets_values` never appears in the core.
- **Diagnostics**: six codes — `DUPLICATE_NODE_ID` / `DUPLICATE_LINK_ID` / `OUTPUT_SLOT_OUT_OF_RANGE` / `LINK_TABLE_MISMATCH` (three-way cross-check between inputs and the links table) / `TYPE_MISMATCH` / `MISSING_REQUIRED_INPUT`. UI links are cross-checked across three places (links table, `inputs[].link`, `outputs[].links`). `top` and each subgraph are separate scopes, so identical IDs across scopes are not flagged.

Output has five sections: key nodes / connections / editable parameters / diagnostics / subgraphs (plus a UI-unresolved section). A subgraph shows only id, name, node count, link count, input/output ports, bounding boxes and instance nodes; its internals are not analysed.

## Draw mode

The installer adds a fifth agent preset, **Draw mode** (`draw`, ordered after Standard / PTC / Minimal / Create). It mounts a slim plugin set (persona, time, files, compaction, ask-user, todo, present) and swaps the persona for a rendering assistant: turn the request into a positive prompt → `comfy_run` → `comfy_result`; variants go through img2img / upscale / review.

Sessions in that preset get **two extra controls at the left of the composer**:

| Control | Writes | Effect |
| --- | --- | --- |
| Image-model dropdown | `draw.unet` | Used whenever `comfy_run` / `comfy_review` omit `unet`; "auto" means the first file in `diffusion_models`, or the first `checkpoints` entry when that folder is empty |
| `LoRA` chip | `draw.lora` | Only when it is on may `comfy_run` / `comfy_review` attach `lora`; otherwise the call is rejected |

The dropdown has two groups, and the group decides which loader the workflow uses:

| Group | Comes from | Workflow | Notes |
| --- | --- | --- | --- |
| Diffusion models | `models/diffusion_models` | `UNETLoader + CLIPLoader + VAELoader` | A single diffusion model; it needs a separate text encoder and VAE |
| Checkpoints | `models/checkpoints` | `CheckpointLoaderSimple` | One file carries MODEL/CLIP/VAE — Illustrious / 光辉 style SDXL checkpoints live here |

Both write **immediately** (click and it takes effect — a different contract from the settings page's draft-then-save). They render only in that preset: the check is the session's `agentPreset` projection being `draw`, so other modes never show them, and the model is told that elsewhere it must pass `unet` explicitly and cannot use LoRA.

**The model cannot see what those two controls are set to.** To find out, it calls `comfy_models` — whose first section is the current draw config:

```
当前绘图配置
  生图模型：<your model>.safetensors（固定，comfy_run 传 unet 不会覆盖）
  LoRA：允许挂
  提示词文档：<your prompt directory>（字数预算 4000；挂了 LoRA 会自动把里面挑中的 tag 段并进 prompt）
```

Those three lines matter: without them the model can only guess from world knowledge which checkpoint is in use and whether LoRA may be attached — which is exactly how you end up with it comparing Illustrious / 光辉 in its reasoning after you picked anima.

### Drawing a specific character: `lora: "auto"`

`lora` on `comfy_run` / `comfy_review` accepts `"auto"` in addition to a literal file name — it picks a LoRA by the **character name** that appears in `prompt` (`comfy_review` matches against `requirement`).

Matching is alias-based: the file name, the doc title, and the alternative spellings inside that title's parentheses — Chinese, Japanese and romaji all count.

Three rules:

- **Only a unique hit is attached.** Zero matches → the image is still generated, and the result says it could not match any character name, pointing at `comfy_models` for the alias table.
- **Several matches means none is attached.** Naming two characters at once lists the candidates (and which alias each one hit) and lets you choose — guessing wrong is worse than not attaching.
- **Spellings the docs never mention do not match.** A kana form like `カナヲ`, or a romaji abbreviation, will not resolve. Pass the LoRA file name to `lora` directly in that case.

One more thing: **prompt documents are only read when `lora` is passed**. Without it the plugin reads no file at all — and the result says so ("this call passed no lora, so no document was read") rather than letting you assume it did.

The preset declaration ships inside the plugin's own `cordis.patch.yml`, so installing the package installs the mode. To change the persona or the plugin set, override `preset-draw`'s `config.plugins` in the profile patch (the override **replaces** the list wholesale).

## Requirements

- A working ComfyUI (looked for at `http://127.0.0.1:8188` by default)
- DSH `>= 0.2.0-rc.1`, Node `>= 22`
- The built-in txt2img template has two loading paths: a name from `diffusion_models` goes through `UNETLoader + CLIPLoader + VAELoader` (so `models/text_encoders` and `models/vae` need at least one file each), while a name from `checkpoints` goes through `CheckpointLoaderSimple`, where one all-in-one file is enough (Illustrious / 光辉 style SDXL checkpoints). An empty `diffusion_models` is fine as long as `checkpoints` has something.

## Install

From npm (recommended):

```bash
dsh plugin --profile web add dsh-comfyui-link
```

To follow the latest code, install from GitHub:

```bash
dsh plugin --profile web add github:jx70/dsh-comfyui-link
```

For local development (when you want edits to take effect immediately), install from a clone:

```bash
git clone https://github.com/jx70/dsh-comfyui-link.git
dsh plugin --profile web add link:/path/to/dsh-comfyui-link
```

Restart DSH, open the **new-session mode menu** and you should see **Draw mode**; then open **Settings → ComfyUI Bridge** — if the review-model dropdown fills in, the connection works.

Installing also writes the package name into your profile's `dsh.profile.bundles` automatically. **You never edit any yml by hand.**

Uninstall:

```bash
dsh plugin --profile web remove dsh-comfyui-link
```

## Usage

> These work best in a **Draw mode** session, where the render model and LoRA controls sit at the left of the composer. Other modes still work — just pass `unet` explicitly, and LoRA is unavailable.

**One-line image generation**

> Draw "a little robot by a rainy window, warm desk lamp", 832×832, 24 steps

The model calls `comfy_run` (template mode) then `comfy_result` to bring the image back.

**Let a review model gate the render**

Turn on the review switch in settings and pick a vision-capable model from the dropdown, then:

> Draw a fan-art of Shinobu Kocho, then have the review model check character fidelity and redraw if it's off

The model runs `comfy_run`, then `comfy_review` (with the `prompt_id` and the original requirement). The review model looks at the image, and if unsatisfied the plugin re-renders from its suggested prompt until satisfied or `maxAttempts` is reached. The result includes every round's verdict / score / feedback / new prompt.

To make the judgement sharper than a vague "character fidelity", pass the `prompt_id` of an earlier render as `reference_prompt_id`: both images go to the review model, which compares hair style / hair colour / eye colour / outfit / palette / overall vibe item by item.

**img2img**

> Redraw that image (prompt_id xxx) with a seaside background, denoise 0.5

Uses `comfy_run` with `mode="img2img"`; `image_prompt_id` points at the base image and `denoise` controls how far it drifts from the original. Turn on the img2img switch in settings first.

**LoRA**

> Draw a portrait with the my_style LoRA, strength 0.8

Uses `comfy_run` in template mode with `lora` / `lora_strength`. Use `comfy_models` to see what's installed. **Turn the `LoRA` chip on in the composer's draw control first** (Draw mode only).

**Upscale**

> Upscale the image from prompt_id xxx to 2048×2048

Calls `comfy_upscale`. The upscale switch must be on.

**Your own workflow**

In the ComfyUI UI, export the workflow in **API format** — a JSON blob shaped like `{ "nodeId": { "class_type": ..., "inputs": ... } }` — and hand it over:

> Run this workflow, change the prompt to "seaside lighthouse" and the seed to 777

The model uses `comfy_run` in graph mode; the prompt is written into the `CLIPTextEncode` node (or the one named by `prompt_node`). Graph mode ignores the three feature switches — it doesn't depend on the built-in template.

## Settings page

Settings → ComfyUI Bridge.

The page follows the look of the shipped settings pages: every group is a card (`settings-card-fill` background, `settings-card-stroke` border, 16px radius), field names and notes use the theme's `label-secondary` / `label-tertiary`, and buttons and switches use `button-primary-fill` / `brand-primary` / `switch-thumb`. **Nothing on the page hardcodes a colour**, so light and dark both follow the theme — switching skins needs no edit here.

| Group | Field | Default | Notes |
| --- | --- | --- | --- |
| Review | `enabled` | off | Master switch for review-and-redraw (the section header carries the subtitle "Auto-check after generation and regenerate on dissatisfaction") |
| | `provider` | empty | Review model provider; empty falls back to the current session model |
| | `model` | empty | Review model id; empty falls back to the current session model |
| | `maxAttempts` | 1 | Max redraws (1–5) |
| | `extra` | empty | Extra review requirements (e.g. "the character must have silver hair") |
| Feature switches | `img2img.enabled` | off | When off, `mode="img2img"` is rejected |
| | `upscale.enabled` | off | When off, `comfy_upscale` is rejected |
| Output | `dir` | empty | Where fetched images are copied; empty keeps them only in ComfyUI own output. **No text field here** — only the **Pick** button (native folder dialog) and a **Clear** button |
| LoRA prompts | `dir` | empty | Directory of prompt documents; empty means no file is read at all. Same **Pick** / **Clear** pair, and the row then reports "N document(s) found" |
| | `maxChars` | 4000 | How many characters of one document may be merged into `prompt` (200–20000). Over budget it cuts at a blank line / newline / comma instead of mid-tag |

`provider` / `model` are **a single dropdown**, not free text: when the settings page opens, the browser fetches a list of vision-capable models from the host (`GET /api/comfyui/vision-models`, grouped by provider). Leaving it empty means "follow the current session model". The list is fetched once when the page opens — there is no Refresh button. The dropdown is independent of the review switch — you can inspect the available models before enabling anything.

Edits stay as a local draft (the row says "unsaved changes") until you press **Save** at the bottom, which writes to the profile; no DSH restart is needed afterwards.

The two feature switches are **off on purpose**: each of them adds nodes and time on the ComfyUI side. Defaults off guarantees "install and get one image", everything else is opt-in. img2img and Upscale are now grouped under one "Feature switches" section instead of two separate bordered blocks, and the **Save** button sticks to the bottom of the panel so it stays visible when scrolling the long form.

> LoRA is not on this page: it is a per-render choice, so it lives in the composer's draw control (`draw.lora`), visible only in Draw mode.

The output directory (`output.dir`) has three shapes:

| What you write | Where the images go |
| --- | --- |
| empty | Left only in ComfyUI own output; nothing is copied |
| an absolute path (e.g. `<your gallery>/comfy`) | Used as-is; every fetch is copied there as well |
| a relative path (e.g. `dsh/copies`) | Resolved under **ComfyUI own output**; if ComfyUI's location cannot be detected it errors out and asks for an absolute path |

"Absolute" is not decided by `path.isAbsolute` — that answers oppositely for `X:/…` on Windows and Linux, so the plugin has its own `looksAbsolute` (drive-letter form, leading `/`, leading UNC `\\`), which gives the same verdict from one config on both platforms.

**The Pick button**: this row has **no text field** — the path can only come from the native folder dialog. The button posts to `POST /api/comfyui/pick-directory`; the host then launches a native Windows folder dialog (`powershell.exe -STA` plus the WinForms `FolderBrowserDialog`, forced in front of the browser) and hands the chosen path back to the page. The **Clear** button next to it empties the selection (back to "images stay in ComfyUI own output"). Four things worth knowing:

- The picked path **lands in the draft only** — you still press **Save**, so a stray click cannot rewrite your config.
- The dialog is **blocking**: the request stays open until you choose, and the plugin times it out after 180 seconds. A second click while one dialog is open is rejected by the host (409, "a picker is already open").
- Windows only. On any other platform the button reports that no native picker exists, so this row cannot be set from the page — edit `output.dir` in the profile's `cordis.patch.yml` instead (a relative path is still resolved under ComfyUI own output).
- Chinese paths never travel over the child process stdout (the console code page would mangle them) — they go through a UTF-8 temp file instead.

`save_to` **overrides per call**: any `comfy_result` / `comfy_review` / `comfy_upscale` that passes `save_to` uses it and ignores the settings field. Existing files are never overwritten — a `-1` / `-2` suffix is appended instead.

## LoRA prompt documents

Many character LoRAs ship with their own notes — trigger words, outfits, palette. Drop those documents into one directory and pick it under **LoRA prompts → Prompt directory**: **whenever a LoRA is attached, the plugin reads the directory and picks the document that best fits that LoRA, folding its tag blocks into `prompt` and its `negative:` section into `negative`**.

Prose in those documents (model info, the author's commentary, pitfalls, parameter advice) is **never merged** — it is noise to the encoder and it is what makes a character come out wrong. The plugin decides line by line which lines are actually tags, and takes only those.

**Outfits are picked one at a time — never mixed.** Many character documents list several outfits at once (`── ① casual / ② maid / ③ waitress / ④ cheongsam`, or a whole set in one section). The old "pick whichever lines look like tags" would merge all of them into `prompt` at once — `white shirt` + `maid` + `waitress` + `china dress` fighting each other, so the character locks onto a default costume and the only way to change scenes was to turn the whole document off. The plugin now first splits the document into mutually-exclusive "outfit" units, then picks the one you ask for: say "maid outfit" and only the maid block + the character identity anchor go in; say nothing and it takes the anchor + the first outfit; ask for an outfit the document doesn't have (even via the synonym buckets) and it merges only the character identity, with the result saying "write the outfit yourself". **You no longer need `lora_doc:"off"` to change clothes.**

| What you do | What happens |
| --- | --- |
| `comfy_run` with `lora` | Read every document → score them → take the best one → pick the **one outfit** you named (plus the character identity anchor) and append its tags to `prompt`, with its `negative:` block merged into `negative` → the result text says "prompt document: xxx.md (picked by content…; merged into prompt, the "maid" outfit + 42 chars of anchor, 291 chars total, 4 outfits left out…)" |
| `comfy_run` with `lora: "auto"` | Pick a LoRA by the character name in `prompt` first (Chinese / Japanese / romaji all match — see above), then behave exactly like "with `lora`"; no match or several matches means nothing is attached, with the reason in the result |
| `comfy_run` with `mode="graph"` and a `LoraLoader` in the workflow | Same — every `LoraLoader` / `LoraLoaderModelOnly` node is scanned, its `lora_name` looked up, and a hit is written into the positive `CLIPTextEncode`; negative tags follow the `KSampler`'s `negative` link to the matching `CLIPTextEncode`. No `lora` argument needed |
| `comfy_review` with `lora` | Same; the redraw keeps both parts, so the second round does not lose the character setup |
| pass `lora_doc: "off"` | Skip it for this one call only — the result then says "passed `lora_doc:"off"`, skipped the document" |
| no `lora` passed (but a directory is configured) | **Not a single file is read**; the result adds "this call passed no lora, so no document was read. To draw a specific character pass `lora:"auto"`, or give `lora` the LoRA file name" |
| leave the directory empty | **Not a single file is read** — identical to the behaviour before this feature existed; but with a LoRA attached the result still says "no LoRA prompt directory configured, so no document was read" |

**Attaching a LoRA always leaves a trace**: hit, miss, directory not configured, or skipped by `off` — all four end up as one line in the result text, so you never have to guess whether it looked.

**How it picks**: the directory may mix anything (character notes, style notes, tag lists, even the model files themselves) and file names need not match the LoRA — every recognised document is read and scored:

| Signal | Points |
| --- | --- |
| The document sits in the **same folder as the LoRA's model file** (and that folder has only this one model) | +120 |
| Same folder, but other models sit alongside it | +60 |
| File name equals the LoRA name | +100 |
| File name contains the LoRA name | +70 |
| Subfolder name equals the LoRA name | +70 |
| File name hits some words of the LoRA name | ratio × 60 |
| Body mentions the LoRA name (spaces, underscores and hyphens flattened) | +30 (partial hits × 12) |
| Title equals / contains the LoRA name | +35 / +25 |
| Has a `Prompt` / `提示词` heading | +20 |
| Content itself is a comma-separated tag list | +12 |

Three outcomes:

- **match**: best score ≥ 45 — the placement, name or body really points at this LoRA; use it.
- **sole**: nothing scores high enough, but exactly **one** document looks like a prompt — use it and say "it does not name this LoRA" in the result.
- **none**: nothing looks like a prompt — **merge nothing**. Better to feed less than to stuff prose into `prompt`.

Only `.md` / `.markdown` / `.txt`; up to 3 levels of subfolders (grouping by character or style works, and folder names are scored too); files over 256 KB are skipped. Model files (`.safetensors` / `.ckpt` / `.pt` / `.pth` / `.bin` / `.gguf` / `.sft`) are never read as documents — they are only used to decide which LoRA a document sits next to.

Scoring has a budget of its own: **at most the first 120 documents per directory are scored, with 4 MB of total reads** (so one render never turns into a disk crawl). When a limit is hit the plugin stops reading and **says so**: the result text adds "N more documents were not scored (over the 120-document limit: xxx, yyy, zzz …)", and `comfy_lora_doc` lists them too. The separate "skipped" list covers a different case — read failures and files over 256 KB.

What goes inside one document:

```markdown
# Silver-haired character

This LoRA was trained on Belle Anima v1 for SDXL.

## Prompt

masterpiece, 1girl, silver long hair, red eyes, black dress
```

With a `# Prompt` / `## Prompt` / `## 提示词` heading only **the section below it** is looked at (up to the next heading of the same or higher level); without one, the whole file is looked at — but **looking** and **merging** are two different things:

**Only tag blocks are merged into `prompt`, and only one outfit at a time.** The body is split into blocks on blank lines and then judged line by line: a line qualifies only if it is comma/、/semicolon separated, has enough segments, is almost entirely short ASCII fragments, does not end with a full stop, is not Chinese prose, is not a table, and carries no full-width parentheses. Qualifying lines go into `prompt`; everything else (`【一】model info`, the author's commentary, breakdowns, pitfall lists, parameter advice, `作者备注：…`) is skipped. That kills the "the more verbose the document, the dirtier the prompt" trap — the merged result is pure tags and **zero CJK characters**.

**Picking the outfit.** When a document is one-outfit-per-section (`── ① casual` / `② maid` / `③ waitress` / `④ cheongsam`, or `① witch / ② school / …`), or one section carrying several outfits split by a leading Chinese label (`军装 peaked cap, …` / `校服 school uniform, …`), the plugin first cuts them into mutually-exclusive "outfit" units. The outfit you name in `prompt` (Chinese or English tags both match, and synonyms like `穿便服` → `私服` / `casual` → `casual wear` do too) selects exactly one; when it hits an in-section row label the report says which outfit that was (the Miu Yarai "five outfits in one section" case). No name → the first outfit; name the document doesn't have → "write the outfit yourself".

**Positive and negative are split automatically.** `负面：`, `负面额外加：`, `负面（…）：`, `—— 可用负面词 ——` and `negative prompt:` are all recognised, and the tag blocks under them go into `negative` (merged and de-duplicated with your own negatives, yours first); `正面：` / `positive:` switches back. Section separators (`========`, `【五】`, `▍① …`, `## …`) reset the state, so a negative sub-section sitting in the middle of positive ones cannot bleed.

A few impurities are cleaned along the way: a leading Chinese label (`军装 peaked cap, …` → `peaked cap, …`) and bracketed placeholders (`[在这里写你要的服装标签]`).

The **character budget** (`loraDocs.maxChars` on the settings page, default 4000, adjustable 200–20000) bounds **how many characters of tag text get merged**: the named outfit (plus the character identity anchor) is merged first, and no further outfit is added once the budget would overflow. When a document is a single tag list with no "outfit" structure at all, it falls back to the boundary cut: **last blank line → newline → comma/、/semicolon → space**, with a candidate required to sit at least 60% into the budget; only when nothing qualifies does it fall back to a hard cut — so a half tag like `long_hair, blue` never reaches the encoder. The result text reports which outfit was merged, how many anchor characters, the total, the negative characters, and which outfits were left out.

In practice many character documents — Chinese "prompt lists" especially — carry no `#` heading at all, only `【一】` / `【三】`-style section markers. Those count as "no heading"; tags are still picked line by line, unaffected.

To see what the plugin actually picked, call `comfy_lora_doc`: with no arguments it lists the candidates (with their subfolder paths and which ones look like prompts); with `lora` it returns the **score table** plus the chosen document's tag blocks and negative block, reporting "which outfit was merged / how many characters / how many prose blocks skipped / how many negative characters"; add `prompt` (the one you intend to use) and it previews the pick by the outfit you named, matching what a render would actually merge; `rest: true` shows the outfits that were left out (or, in plain mode, the tail cut by the budget), `full: true` returns the whole file. The tool **never throws** — no directory, a wrong path, or no match all come back as a one-line explanation.

## Configuration

Static values such as the server address ship in the bundled `cordis.patch.yml`:

```yaml
- insert:
    - id: comfyui
      name: dsh-comfyui-link
      config:
        baseUrl: 'http://127.0.0.1:8188'   # your ComfyUI address
```

To change the address, override the same entry in your profile's `cordis.patch.yml`:

```yaml
- id: comfyui
  config:
    baseUrl: 'http://192.168.1.9:8188'
```

Other options (overridable in the same place):

| Field | Default | Notes |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:8188` | ComfyUI address |
| `timeoutMs` | `20000` | Per-request HTTP timeout |
| `pollMs` | `2500` | `comfy_result` polling interval |
| `maxWaitSeconds` | `900` | Max wait for a single job |
| `outputRoot` | `''` | Directory where output images land. **Empty means auto-detect** from the launch arguments reported by `/system_stats` — usually you don't need to set it. This is the *read* path (used to build on-disk paths and to resolve a relative output directory); the *copy* target is `output.dir` on the settings page |

`comfy_review` details:

| Parameter | Purpose |
| --- | --- |
| `reference_prompt_id` | **Character reference.** Pass the `prompt_id` of a previous render and the review model gets both images, so it can compare hair style / hair colour / eye colour / outfit / palette / overall vibe. Extraneous elements in the reference are explicitly excluded from the requirement |
| `max_attempts` | Overrides `maxAttempts` from settings (0–5) |
| `lora` / `lora_strength` | Attach a LoRA when redrawing (turn the composer's LoRA chip on first), same semantics as `comfy_run` |

Redraws **keep the base image's dimensions** (rounded to a multiple of 16) — a 768-wide image won't silently become 1024.

## How it works

Three layers with clear boundaries:

- `lib/comfy.mjs` — pure HTTP client + workflow construction (`buildTxt2Img` / `buildImg2Img` / `buildUpscale` / `normalizeGraph` …), **imports nothing from `@deepseek-ai/*`**, runs standalone
- `index.js` — the host plugin: registers 10 tools, a system-prompt section, a schemastery `Config` (from which the settings form is generated), and four routes: `GET /api/comfyui/vision-models` (review models), `GET /api/comfyui/draw-models` (render models and LoRAs), `GET /api/comfyui/lora-docs` (prompt documents) and `POST /api/comfyui/pick-directory` (native folder dialog)
- `lib/format-adapter.mjs` — workflow format adapter (UI ↔ API), with UI link three-way cross-check and subgraph boundary detection
- `lib/inspector.mjs` — workflow semantic core (pure functions, API graph only)
- `client.js` — the browser half, two pieces of UI: the "ComfyUI Bridge" page in the `settings.section` slot (draft + save) and the draw control in `conversation.input.left` (Draw mode only)

`index.js` also does `import z from '@deepseek-ai/schemastery'` to declare `export const Config`, which is why `dependencies` contains that one package and nothing else at runtime.

Why three layers: a bug in workflow construction shouldn't require booting the whole host to locate. `npm run selftest` hits ComfyUI directly and verifies `lib/` in seconds. The full design rationale is in [docs/DESIGN.md](./docs/DESIGN.md).

## Desktop

DSH Desktop (Electron) loads the same Web GUI and the same `client.js` — `dsh.client.platform: "web"` is enough, no separate declaration is needed. The difference is the **page origin**: the Desktop page comes from `dsh-app://app/`, not an http origin, so a relative `/api/...` request cannot reach the host there. Two adaptations cover it:

| Situation | Browser | Desktop |
| --- | --- | --- |
| Reading model lists, calling routes | the page's own `fetch` | `globalThis.__DSH_TRANSPORT__.fetch` (injected by the preload; takes document-relative paths and resolves them to the host itself) |
| Picking a directory | `POST /api/comfyui/pick-directory`, the host spawns `powershell.exe -STA` | `globalThis.__DSH_DIRECTORY_PICKER__.pick()`, Electron shows the native dialog (cancel returns `null`) |

Both are **capability probes**: use the bridge when it exists, otherwise fall back to the browser path. The same bundle therefore runs under Web and Desktop, and the plugin never needs to know which one it is in.

`hostFetch()` strips the leading slash before handing the path to the transport bridge — that is what the shipped code does (in `createWebConnectionRpc` the request goes out as `channel/endpoint` with the first character sliced off, and HMR does the same to `/plugins/events`). Don't pass a full `/api/...` path: it would be resolved against `dsh-app://app/` and never reach the host.

## Compatibility and known limits

- **Verified against ComfyUI 0.30.2.** Older versions most likely work, but newer endpoints such as `POST /api/jobs/{id}/cancel` may not exist there — `comfy_control`'s `cancel` would return 404 while `interrupt` still works.
- **Web client only**: `dsh.client.platform` is `web`, so the settings page needs a graphical shell. DSH Desktop loads that same Web GUI, so it works there too; tools still work in pure CLI use, you just can't flip the switches there (put them in `cordis.patch.yml` instead).
- **The built-in template handles both layouts**: a standalone model in `diffusion_models` uses the three-piece loaders, an all-in-one file in `checkpoints` uses `CheckpointLoaderSimple`. Whichever folder the name lives in decides the loader; on a name collision the checkpoint wins. A checkpoint name can be passed straight to `comfy_run`'s `unet`.
- **Upscale is algorithmic**: `ImageScale` with lanczos / bicubic etc., not an upscale model (ESRGAN and friends). For AI upscaling, build your own workflow and use graph mode.
- **The review model must accept images**: the settings dropdown only lists models whose `inputModalities` include `image`. A text-only model will be rejected downstream.
- **Rendering is synchronous waiting**: `comfy_result` polls for up to `maxWaitSeconds`. A timeout doesn't lose the job — call it again.

## FAQ

**Installed, but the tools don't show up?**
Restart DSH. ESM modules and the profile's bundle list are read at startup, so a `link:` install does nothing until then. If `dsh plugin --profile web list` shows the package but the model has no tools, it's almost always a missing restart.

**The model list is empty?**
That means `GET /api/comfyui/vision-models` isn't reaching the host. First confirm the address shown on the settings page connects (that's the ComfyUI address, not DSH's); then confirm the current session's provider has a vision-capable model. If the list is empty but the plugin is otherwise fine, leave the review `provider` / `model` empty — it falls back to the current session model.

**No draw control at the left of the composer?**
Then the session isn't in Draw mode — those controls are registered only for sessions whose `agentPreset` is `draw`. Pick **Draw mode** when creating a session; an existing Standard / PTC / Minimal / Create session won't grow them, because a preset is fixed once the conversation starts.

**Pressing Save does nothing?**
Read the note at the right of the save row: `保存失败` carries a concrete reason (usually `Config field "..." is not volatile`, meaning that field isn't declared volatile and the page can't write it). "unsaved changes" means the draft hasn't been submitted yet, and the button should be enabled.

**`comfy_status` says it can't connect?**
The plugin looks at `http://127.0.0.1:8188` by default. If ComfyUI runs on another host or port, override `baseUrl` in your profile's `cordis.patch.yml` (see [Configuration](#configuration)).

**`comfy_models` says a folder is empty?**
The built-in template needs one usable model: either something in `diffusion_models` (which also needs one file each in `text_encoders` / `vae`), or one all-in-one file in `checkpoints`. With both empty, use `mode="graph"` with your own workflow.

**I changed the code but behaviour didn't change?**
ESM caches modules — after editing `lib/*.mjs` or `index.js`, disable and re-enable the plugin, or restart DSH. After editing `client.js` you also need a backend restart, because the client bundle is built and cached.

## Development

```bash
npm test                      # pure unit tests: graph building / registration shape / config guards. No ComfyUI needed
npm run smoke                 # fake-ctx smoke: registration, schema validation, render
npm run smoke:live            # additionally call the read-only tools for real (needs ComfyUI)
npm run e2e                   # end-to-end: submit → fetch → verify image blocks (renders a real 512×512)
npm run selftest              # drive lib/comfy.mjs directly against ComfyUI (read-only)
npm run probe:route           # fake ctx, verify the vision-model filtering
npm run probe:http            # real HTTP: verify the route sits inside the trust fence
npm run probe:features        # real renders: template / img2img / LoRA / upscale + switch gating
npm run probe:bundle          # verify the client bundle the browser receives contains the new code (DrawBar / save button / four routes / two desktop bridges)
```

The probes that talk to a live DSH (`probe:http` / `probe:bundle`) read their environment from variables and **skip (exit 0)** when it's unavailable, so they don't paint CI red:

| Variable | Default | Notes |
| --- | --- | --- |
| `COMFY_URL` | `http://127.0.0.1:8188` | ComfyUI address |
| `DSH_BASE` | `http://127.0.0.1:3080` | Running DSH web address |
| `DSH_CREDENTIALS` | the credentials file under `<home>/.dsh/` | DSH credentials file path |
| `DSH_AUTH_COOKIE` | empty | Supply a ready-made cookie; skips reading the credentials file |
| `DSH_HOST_MODULES` | auto-resolved | `@deepseek-ai/*` host package directory (used by `smoke` for real schema validation) |
| `COMFY_LORA` | empty | LoRA filename for `probe:features`; that section is skipped when unset |

See [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) for more.

### Contributing

Run `npm test` and `npm run smoke` before opening a PR — CI runs those two plus `probe:route` and `npm pack --dry-run` on ubuntu-24.04 / windows-latest × node 22 / 24 (the Linux image is pinned on purpose; see the comment in [.github/workflows/ci.yml](./.github/workflows/ci.yml)). The suite includes a set of "de-localisation" assertions (no absolute paths from the author's machine, no hardware specifics, no install commands that would pull somebody else's package); follow their error messages.

The traps that cost real time while editing code are listed in [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md).

## Gotchas

These cost real debugging time; writing them down saves you one round:

- **Node ids in links must be strings**: `["2", 0]` works, `[2, 0]` makes ComfyUI raise `KeyError` at `execution.py:933`.
- **Never `export default apply`**: `cordis-plugin-loader`'s `unwrapExports` would grab the bare function, dropping `inject` and the other named exports, and startup fails with `cannot get property "tools" without inject`.
- **Reload the plugin after editing source**: ESM modules are cached; after changing `lib/*.mjs` you must disable and re-enable the plugin.
- **Don't edit source files with Chinese text through PowerShell pipes**: `Set-Content` corrupts UTF-8 into an immediate SyntaxError.
- **Volatile fields are reference objects**: schemastery `.volatile()` fields arrive as cosmokit references inside `apply()`; call `.get()` to unwrap, which is exactly what makes settings-page and composer edits take effect live. The flip side: **only volatile fields are writable** — the host rejects anything else with `Config field "..." is not volatile`.
- **img2img uploads first**: `LoadImage` can only read files inside ComfyUI's `input/` directory, so `buildImg2Img` is preceded by `client.uploadImage()` (`POST /upload/image`).
- **The model list routes must use `connection.fetch`**: registering your own `/api/...` with `webServer.register` gets swallowed by the outer prefix router and always returns 401.
- **Read the session through standard slot props**: a `conversation.input.left` component receives `sessionId` / `useSessions` directly; detect the preset the way the shipped `AgentPresetLabel` does — `state.byId[sessionId].projectionValues.agentPreset` — and pass your own handles in through `inject: (sessionId) => ({...})`.
- **Don't use `path.isAbsolute` for platform-neutral checks**: it says true for `X:/…` on Windows and false on Linux, so one config yields opposite verdicts. The plugin has `looksAbsolute` (drive-letter form, leading `/`, leading UNC); `output.dir` is resolved through it.
- **Don't edit `package.json` with `Set-Content -Encoding UTF8`**: it prepends a BOM and `npm test` fails with `SyntaxError: Unexpected token '﻿'`. Use node's `fs.writeFileSync(path, text, 'utf8')`.
- **Desktop must not call `fetch('/api/…')` directly**: the Desktop page is `dsh-app://app/`, so a relative path resolves against that custom scheme and never reaches the host. Either use `globalThis.__DSH_TRANSPORT__.fetch` (paths without a leading slash) or probe for it and fall back to the page's own `fetch`. The plugin routes everything through `hostFetch()`.

## License

[MIT](./LICENSE) · see [CHANGELOG.md](./CHANGELOG.md)
