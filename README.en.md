# dsh-comfyui-bridge

Drive your own ComfyUI from [DeepSeek Harness](https://github.com/deepseek-ai) (DSH): write prompts, tweak parameters, build workflows, submit jobs, and pull the resulting images back for the model to look at. It can also designate a **review model** that inspects each render and automatically re-draws it when the result doesn't meet the requirement.

> 中文说明见 [README.md](./README.md)

## What you get

Eight tools become available to the model:

| Tool | What it does |
| --- | --- |
| `comfy_status` | Is the server alive, how much VRAM is free, what's queued, how the recent jobs went |
| `comfy_models` | Which model files exist (`diffusion_models` / `text_encoders` / `vae` / `checkpoints` / `loras`) |
| `comfy_node` | Inspect a node class: accepted inputs, defaults, ranges, enum values |
| `comfy_run` | Submit a job — `mode="template"` txt2img (optionally with a LoRA), `mode="img2img"`, or `mode="graph"` with your own API-format workflow |
| `comfy_result` | Wait for the job, fetch the output images, actually show them to the model, report on-disk paths, optionally `save_to` |
| `comfy_control` | Cancel a job / interrupt the running one / clear the queue / free VRAM |
| `comfy_review` | **Review-and-redraw**: let the designated model judge the image, and re-render from its suggested prompt until it's satisfied or the attempt limit is hit. Pass `reference_prompt_id` to check character fidelity against a reference |
| `comfy_upscale` | Algorithmic upscale (`ImageScale`, lanczos by default) of an already generated image |

## Requirements

- A working ComfyUI (looked for at `http://127.0.0.1:8188` by default)
- DSH `>= 0.2.0-rc.1`, Node `>= 22`
- The built-in txt2img template uses `UNETLoader + CLIPLoader + VAELoader`, so `models/diffusion_models`, `models/text_encoders` and `models/vae` each need at least one file. If you organise everything as `checkpoints`, use `mode="graph"` with your own workflow instead.

## Install

From npm:

```bash
dsh plugin --profile web add dsh-comfyui-bridge
```

From a local checkout (for development):

```bash
dsh plugin --profile web add link:/absolute/path/to/dsh-comfyui-bridge
```

Restart DSH, open **Settings → ComfyUI Bridge**, and hit **Refresh** — if the model list appears, the connection works.

Uninstall:

```bash
dsh plugin --profile web remove dsh-comfyui-bridge
```

## Usage

**One-line image generation**

> Draw "a little robot by a rainy window, warm desk lamp", 832×832, 24 steps

The model calls `comfy_run` (template mode) then `comfy_result` to bring the image back.

**Let a review model gate the render**

Turn on the review switch in settings and pick a vision-capable model from the dropdown, then:

> Draw a fan-art of Shinobu Kocho, then have the review model check character fidelity and redraw if it's off

The model runs `comfy_run`, then `comfy_review` (with the `prompt_id` and the original requirement). The review model looks at the image, and if unsatisfied the plugin re-renders from its suggested prompt until satisfied or `maxAttempts` is reached. The result includes every round's verdict / score / feedback / new prompt.

**img2img**

> Redraw that image (prompt_id xxx) with a seaside background, denoise 0.5

Uses `comfy_run` with `mode="img2img"`; `image_prompt_id` points at the base image and `denoise` controls how far it drifts from the original.

**LoRA**

> Draw a portrait with the my_style LoRA, strength 0.8

Uses `comfy_run` in template mode with `lora` / `lora_strength`. Use `comfy_models` to see what's installed.

**Upscale**

> Upscale the image from prompt_id xxx to 2048×2048

Calls `comfy_upscale`.

**Your own workflow**

In the ComfyUI UI, export the workflow in **API format** — a JSON blob shaped like `{ "nodeId": { "class_type": ..., "inputs": ... } }` — and hand it over:

> Run this workflow, change the prompt to "seaside lighthouse" and the seed to 777

The model uses `comfy_run` in graph mode; the prompt is written into the `CLIPTextEncode` node (or the one named by `prompt_node`).

## Settings page

Settings → ComfyUI Bridge. Changes apply immediately, no restart.

| Group | Field | Default | Notes |
| --- | --- | --- | --- |
| Review | `enabled` | off | Master switch for review-and-redraw |
| | `provider` | empty | Review model provider; empty falls back to the current session model |
| | `model` | empty | Review model id; empty falls back to the current session model |
| | `maxAttempts` | 1 | Max redraws (1–5) |
| | `extra` | empty | Extra review requirements (e.g. "the character must have silver hair") |
| img2img | `enabled` | off | When off, `mode="img2img"` is rejected |
| LoRA | `enabled` | off | When off, `comfy_run`'s `lora` argument is rejected |
| Upscale | `enabled` | off | When off, `comfy_upscale` is rejected |

`provider` / `model` are **a single dropdown**, not free text: when the settings page opens, the browser fetches a list of vision-capable models from the host (`GET /api/comfyui/vision-models`, grouped by provider). Leaving it empty means "follow the current session model". The **Refresh** button re-fetches after you install a provider or switch accounts. The dropdown is independent of the review switch — you can inspect the available models before enabling anything.

## Configuration

Static values such as the server address ship in the bundled `cordis.patch.yml`:

```yaml
- insert:
    - id: comfyui
      name: dsh-comfyui-bridge
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
| `outputRoot` | `''` | Directory where output images land. **Empty means auto-detect** from the launch arguments reported by `/system_stats` — usually you don't need to set it |

`comfy_review` details:

| Parameter | Purpose |
| --- | --- |
| `reference_prompt_id` | **Character reference.** Pass the `prompt_id` of a previous render and the review model gets both images, so it can compare hair style / hair colour / eye colour / outfit / palette / overall vibe. Extraneous elements in the reference are explicitly excluded from the requirement |
| `max_attempts` | Overrides `maxAttempts` from settings (0–5) |
| `lora` / `lora_strength` | Attach a LoRA when redrawing (requires the LoRA switch), same semantics as `comfy_run` |

Redraws **keep the base image's dimensions** (rounded to a multiple of 16) — a 768-wide image won't silently become 1024.

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
npm run probe:bundle          # verify the client bundle the browser receives contains the new code
```

The probes that talk to a live DSH (`probe:http` / `probe:bundle`) read their environment from variables and **skip (exit 0)** when it's unavailable, so they don't paint CI red:

| Variable | Default | Notes |
| --- | --- | --- |
| `COMFY_URL` | `http://127.0.0.1:8188` | ComfyUI address |
| `DSH_BASE` | `http://127.0.0.1:3080` | Running DSH web address |
| `DSH_CREDENTIALS` | `<home>/.dsh/.credentials.yaml` | DSH credentials file |
| `DSH_AUTH_COOKIE` | empty | Supply a ready-made cookie; skips reading the credentials file |
| `DSH_HOST_MODULES` | auto-resolved | `@deepseek-ai/*` host package directory (used by `smoke` for real schema validation) |
| `COMFY_LORA` | empty | LoRA filename for `probe:features`; that section is skipped when unset |

See [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) and [docs/DESIGN.md](./docs/DESIGN.md) for more.

### Three layers

- `lib/comfy.mjs` — pure HTTP client + workflow construction (`buildTxt2Img` / `buildImg2Img` / `buildUpscale` / `normalizeGraph` …), **imports nothing from `@deepseek-ai/*`**, runs standalone
- `index.js` — the host plugin: registers 8 tools, a system-prompt section, a schemastery `Config` (from which the settings form is generated), and the read-only `GET /api/comfyui/vision-models` route the settings page uses
- `client.js` — the browser half: registers the "ComfyUI Bridge" page into the `settings.section` slot and reads/writes volatile fields through `configForms`

## Gotchas

- **Node ids in links must be strings**: `["2", 0]` works, `[2, 0]` makes ComfyUI raise `KeyError` at `execution.py:933`.
- **Never `export default apply`**: `cordis-plugin-loader`'s `unwrapExports` would grab the bare function, dropping `inject` and the other named exports, and startup fails with `cannot get property "tools" without inject`.
- **Reload the plugin after editing source**: ESM modules are cached; after changing `lib/*.mjs` you must disable and re-enable the plugin.
- **Don't edit source files with Chinese text through PowerShell pipes**: `Set-Content` corrupts UTF-8 into an immediate SyntaxError.
- **Volatile fields are reference objects**: schemastery `.volatile()` fields arrive as cosmokit references inside `apply()`; call `.get()` to unwrap, which is exactly what makes settings-page edits take effect live.
- **img2img uploads first**: `LoadImage` can only read files inside ComfyUI's `input/` directory, so `buildImg2Img` is preceded by `client.uploadImage()` (`POST /upload/image`).
- **The model list route must use `connection.fetch`**: registering your own `/api/...` with `webServer.register` gets swallowed by the outer prefix router and always returns 401.

## License

[MIT](./LICENSE)
