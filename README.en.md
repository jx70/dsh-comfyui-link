# dsh-comfyui-link

[![CI](https://github.com/jx70/dsh-comfyui-link/actions/workflows/ci.yml/badge.svg)](https://github.com/jx70/dsh-comfyui-link/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.0--rc.1-blueviolet.svg)](https://github.com/deepseek-ai/deepseek-harness)

Let [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) drive your own ComfyUI: write prompts, submit jobs, and pull the images back so the model can see them. A review model can gate each result and trigger a redraw until it is satisfied.

> 中文: [README.md](./README.md)

## Features

- **12 tools** covering status → capability discovery → generate → fetch → review → upscale → workflow analysis → persistent workflow learning; no ComfyUI HTTP API knowledge needed.
- **Capability discovery**: `comfy_capabilities` maps a task (remove overlay / matting / change background / local edit) to the machine's real models and nodes, so the agent stops guessing from world knowledge and reaching for Python/rembg.
- **Review loop**: a vision model judges the image and rewrites the prompt until satisfied or the attempt cap is hit; pass a reference image to check character fidelity.
- **Draw mode**: a `draw` preset with generation-model and LoRA controls left of the input box.
- **LoRA prompt documents**: point at a folder; when a LoRA is used, the matching doc's tag section is merged into `prompt` and its negative section into `negative`.
- **ComfyUI conversation view**: node graph, edit-and-resubmit, output gallery, queue, and image → workflow lookup.
- **No host internals**: `lib/comfy.mjs` uses only Node's built-in `fetch` and runs standalone.

## Tools

| Tool | What it does |
| --- | --- |
| `comfy_status` | Alive?, VRAM, queue, recent jobs |
| `comfy_models` | Available model files (with capability tags and local capability hints); leads with the current draw config, loras carry character aliases |
| `comfy_capabilities` | Reverse-lookup local capabilities and nodes by task; check this first for unfamiliar image tasks |
| `comfy_node` | Inputs, defaults, ranges for a node class; also accepts a keyword to list candidates |
| `comfy_run` | Submit: `template` txt2img (optional LoRA) / `img2img` / `graph` with your own API workflow |
| `comfy_result` | Wait for the job and return the image (shown to the model) plus its path, optional `save_to` |
| `comfy_control` | Cancel / interrupt / clear queue / free VRAM |
| `comfy_review` | Review-and-regenerate; `reference_prompt_id` compares character fidelity |
| `comfy_upscale` | Algorithmic upscale (lanczos by default) |
| `comfy_lora_doc` | Inspect prompt docs: score table, chosen tag and negative sections |
| `comfy_inspect` | Workflow analysis: key nodes, links, editable params, diagnostics (duplicate IDs / broken links / slot range / type mismatch / missing inputs) |
| `comfy_learn` | Persistent workflow knowledge base: `learn` / `recall` / `list` / `get` / `feedback` to accumulate and reuse workflow experience |

## Requirements

- A running ComfyUI (defaults to `http://127.0.0.1:8188`)
- DSH `>= 0.2.0-rc.1`, Node `>= 22`
- The built-in template supports two layouts: a model in `diffusion_models` uses the trio (`UNETLoader + CLIPLoader + VAELoader`, needs one file each in `text_encoders` / `vae`); a bundle in `checkpoints` uses `CheckpointLoaderSimple` and needs only one file.

## Install

```bash
dsh plugin --profile web add dsh-comfyui-link          # npm (recommended)
dsh plugin --profile web add github:jx70/dsh-comfyui-link   # latest code
dsh plugin --profile web add link:/path/to/dsh-comfyui-link             # local dev
```

Restart DSH afterwards: the new-session mode menu should show Draw mode, and Settings → ComfyUI Bridge should list vision models. Uninstall with `remove`.

## Usage

Easiest inside a **draw mode** session (model and LoRA controls sit left of the input box); other modes work too but need an explicit `unet` and cannot use LoRA.

| Want | Say | Path |
| --- | --- | --- |
| Generate | "a little robot by a rainy window, warm desk lamp, 832×832, 24 steps" | `comfy_run` → `comfy_result` |
| Review | "draw Shinobu, then have the review model check fidelity and redraw if it misses" | `comfy_review` (enable review in settings) |
| img2img | "repaint that one with a seaside background, denoise 0.5" | `comfy_run` `mode="img2img"` (enable the switch) |
| LoRA | "draw a portrait with my_style, strength 0.8" | `comfy_run` + `lora` (turn LoRA on in the draw controls) |
| Upscale | "upscale that to 2048×2048" | `comfy_upscale` (enable the switch) |
| Own workflow | Paste an API-format JSON export | `comfy_run` `mode="graph"`, no switches involved |

## Settings page

DSH Settings → ComfyUI Bridge. Edits collect as a draft; **Save** writes them to the profile and takes effect without a restart.

| Group | Field | Default | Notes |
| --- | --- | --- | --- |
| Review | `enabled` | off | Master switch for review-and-regenerate |
| | `provider` / `model` | empty | Vision model (the dropdown lists only image-capable ones); empty follows the session model |
| | `maxAttempts` | 1 | Redraws allowed (1–5) |
| Switches | `img2img.enabled` | off | Blocks `mode="img2img"` when off |
| | `upscale.enabled` | off | Blocks `comfy_upscale` when off |
| Output | `dir` | empty | Copy destination; empty keeps images in ComfyUI's own output. Picker button only, no text input |
| LoRA docs | `dir` | empty | Prompt document folder; empty reads nothing |
| | `maxChars` | 4000 | Max characters merged per doc (200–20000) |

Switches ship off on purpose: install and generate immediately, opt in to the rest. `save_to` overrides per call; existing files get a `-1` / `-2` suffix instead of being overwritten.

## LoRA prompt documents

Drop `.md` / `.txt` character notes into one folder and select it in settings. When a LoRA is used, the plugin scores each doc, picks the closest one, and merges **only its tag section into `prompt` and its "negative:" section into `negative`** — prose (model info, author notes, pitfalls) never reaches the prompt.

- **Outfits are picked as sets**: saying "maid outfit" merges just the maid set plus the character anchors, never uniform + qipao fighting each other.
- **`lora: "auto"`** matches character names in `prompt` against the LoRA list (Chinese / Japanese / romaji). Only a unique hit attaches; multiple hits or none leave LoRA off and say why.
- **No `lora`, no reading** — and the result says so.
- To see what it would pick, call `comfy_lora_doc` (no args lists candidates, with `lora` returns the score table, `rest: true` / `full: true` show more).

## Workflow knowledge base (comfy_learn)

Analyzed workflows can be accumulated for the long term. On a similar request the model retrieves candidates first, reuses them, and refines them with real run evidence. The store lives at `<ComfyUI output>/_dsh_meta/workflow-knowledge/` (`index.json` + `records/wf_*.json`), survives restarts, and is fully separate from `prompt-index.jsonl`.

One tool, five `action`s:

| action | What it does |
| --- | --- |
| `learn` | Learn a new workflow: one of `graph` / `path` / `prompt_id`, plus a `knowledge` summary; returns `workflow_id` |
| `recall` | Search by natural language (`query`); returns candidates plus match reasons; a recommendation is not executable on its own |
| `list` | List learned profiles, filterable by `keyword` / `tag` / `status` |
| `get` | Read a full profile by `workflow_id`; `include_graph: true` returns the original Graph (explicitly reports when unrecoverable) |
| `feedback` | Append a real run/review/user evaluation as a separate event; never overwrites history |

Runnable examples (model-side calls):

```text
# learn a workflow
comfy_learn { "action": "learn", "graph": <workflowJSON>, "name": "structure-preserving upscale",
  "knowledge": { "purpose": ["upscale while preserving source structure"], "use_cases": ["image restoration"] } }
# → note the returned workflow_id, e.g. wf_2f673adb85a453a9

# recall learned workflows
comfy_learn { "action": "recall", "query": "upscale preserving original structure", "limit": 5 }

# read a full profile
comfy_learn { "action": "get", "workflow_id": "wf_2f673adb85a453a9" }

# record a real run as feedback
comfy_learn { "action": "feedback", "workflow_id": "wf_2f673adb85a453a9",
  "prompt_id": "<id from comfy_run>", "execution_outcome": "completed",
  "quality_assessment": "approved", "assessment_source": "user", "feedback": "looks great" }
```

Notes: Inspector facts (nodes / links / diagnostics) are produced by the plugin; the model only supplies semantic explanation. `store_graph` defaults to false so full prompts / image paths are not written into the store. Execution status and quality assessment are tracked separately (`completed` never auto-becomes `approved`). Even on a recall hit, re-check local node/model dependencies and call `comfy_run` only after confirming the workflow fits.

## Configuration

Static values come from the bundled `cordis.patch.yml`. To change the address, override the same block in the profile's `cordis.patch.yml`:

```yaml
- id: comfyui
  config:
    baseUrl: 'http://192.168.1.9:8188'
```

Other options: `timeoutMs` (20000), `pollMs` (2500), `maxWaitSeconds` (900), `outputRoot` (empty auto-detects the ComfyUI install from `/system_stats`; usually leave it).

## Known limits

- Verified against ComfyUI 0.30.2; older builds may 404 on `comfy_control`'s `cancel` while `interrupt` still works.
- Upscaling is algorithmic (`ImageScale`), no ESRGAN-style models; use graph mode for AI upscaling.
- Generation is a synchronous wait: `comfy_result` polls up to `maxWaitSeconds`. A timeout never loses the job — call again.
- The settings page and the draw controls are Web UI. Under plain CLI the tools work but switches cannot be changed (write them in `cordis.patch.yml`).

## Development

```bash
npm test              # unit tests, no ComfyUI needed
npm run smoke         # fake-ctx smoke
npm run smoke:live    # plus live read-only tool calls
npm run e2e           # end to end: submit → fetch → validate image blocks
npm run selftest      # run lib/comfy.mjs against ComfyUI
npm run probe:route   # fake ctx captures routes, checks model filtering
npm run probe:http    # real HTTP, checks routes sit behind the trust fence
npm run probe:features # real generation: template / img2img / LoRA / upscale
npm run probe:bundle  # confirms the served client.js carries the new code
```

Run `npm test` and `npm run smoke` before a PR. Design rationale lives in [docs/DESIGN.md](./docs/DESIGN.md); pitfalls and env vars in [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md).

## License

[MIT](./LICENSE) · changes in [CHANGELOG.md](./CHANGELOG.md)
