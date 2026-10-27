# Local dictation (fork)

Dictation can run on your own computer, with no key and no subscription. It uses [Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), an open model by NVIDIA that transcribes Portuguese, English and 23 other European languages. It detects the language on its own, so you can speak Portuguese or English, or mix both in one dictation, and it writes punctuation and capitals. Local dictation is the default; Deepgram stays available.

## Set up

1. Click **Dictate** (or press Ctrl+D). The first time, the bar asks **Download the dictation model (670 MB)?** Choose **Download**. The bar shows the progress and goes back to **Dictate** when the model is in place. You can also download it in **Settings → Providers → Dictation**.
2. Click **Dictate** again and speak. Click **Stop** (or press Ctrl+D) and the text lands in the message box. Esc discards the dictation, as before.

The model downloads once. After that, dictation works without internet.

**Settings → Providers → Dictation** has:

- **Engine:** **Local (Parakeet)** or **Deepgram**. Deepgram needs its key; its key row only shows when Deepgram is chosen.
- **Parakeet v3**, with the local engine: **Download (670 MB)**, the progress with **Cancel**, or **Downloaded** with **Remove**. Remove is locked while a dictation runs.

Deepgram now detects the language too (`language=multi`) instead of following the tutor language.

## Speed and memory

On a 12-core desktop processor, 30 seconds of speech transcribe in about 2 seconds, on the processor alone (no graphics card needed). Dictation transcribes while you speak: each pause of about a second closes a stretch of speech, which is transcribed in the background. When you stop, the text is ready almost at once, even after a long dictation.

The model uses about 1 GB of memory while loaded. It loads with your first dictation (about 2 seconds; what you say meanwhile is kept) and is released after 10 minutes without dictation.

## How it works

- **The model.** `src/core/dictation.ts` lists the files: the int8 ONNX export of Parakeet v3 by the [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) project, pinned to one Hugging Face revision, and the Silero VAD (MIT), from sherpa-onnx's releases. `src/server/dictation/model.ts` downloads them to `<data>/models/parakeet-tdt-0.6b-v3-int8/` (`%APPDATA%\LearnHarness\data\models\…` in the Windows app). Each file downloads as `<name>.part` and only takes its real name after its size and SHA-256 match.
- **The engine.** `src/server/dictation/engine.ts` runs [sherpa-onnx-node](https://www.npmjs.com/package/sherpa-onnx-node) (Apache-2.0, prebuilt for Windows, macOS and Linux) in a worker thread. Each dictation is a session with its own Silero VAD: a pause of 1 second closes a stretch, stretches longer than 25 seconds are cut, and Parakeet transcribes them one at a time with up to 4 threads. Ending the worker after 10 idle minutes returns the model's memory at once.
- **The audio.** The microphone path is upstream's: the worklet produces 16 kHz 16-bit PCM. For the local engine, `components/dictation-local/local-socket.ts` stands where Deepgram's WebSocket was, with the same events, so upstream's run logic (the queue, the deferred transcript, Esc, finishing before a send) is unchanged. It posts the audio every half second and turns each transcribed stretch into a Deepgram-shaped final.
- **The choice.** The engine is stored in `<data>/dictation.json`, beside upstream's settings record. It lives on the server because the desktop app serves every launch from a new port, which empties browser storage. `components/dictation-local/store.ts` holds it in the window with the model's status.
- **The API** (`src/server/dictation-http.ts`), behind the desktop proxy and the same-origin rule of the other fork controls:

  | Route | Does |
  | --- | --- |
  | `GET /api/dictation` | Engine and model status |
  | `PUT /api/dictation` | `{ "engine": "local" \| "deepgram" }` |
  | `POST /api/dictation/model` | Start the download |
  | `DELETE /api/dictation/model` | Cancel the download, or remove the model |
  | `POST /api/dictation/sessions` | Open a session |
  | `POST /api/dictation/sessions/<id>` | Audio in, transcribed stretches out |
  | `POST /api/dictation/sessions/<id>/end` | Transcribe the rest, close |
  | `DELETE /api/dictation/sessions/<id>` | Discard |

- **Packaging.** `next.config.ts` keeps `sherpa-onnx-node` external and adds its files and the platform package (the `.node` and onnxruntime) to the standalone trace. `scripts/fork/release-windows.ps1` checks that the packaged server loads it with Electron's Node.

Upstream files touched (small, marked "Fork"):

- `components/dictation.tsx`: the token and socket go through the engine choice; the click checks for the model before the microphone turns on; the bar shows the download question; the stop waits up to 20 seconds for the local engine; errors name the engine.
- `components/settings/keys-section.tsx`: the Dictation group's rows.
- `next.config.ts`, `package.json`, `src/core/index.ts`, `src/server/index.ts`.
- `tests/provider-tracing.test.ts` and `tests/chatgpt-connection-ui.test.tsx`: the new trace entries and the dictation status request.

`tests/local-dictation.test.tsx` covers the settings and routes, the verified download (against a local server), the socket, the engine choice and the interface. With a downloaded model it also runs the real engine:

```bash
LH_TEST_DICTATION_MODEL_DIR=<model folder> LH_TEST_DICTATION_WAV=<16 kHz mono 16-bit wav> npx tsx --test tests/local-dictation.test.tsx
```

Only Windows is tested, because the fork ships Windows installers. macOS and Linux use the same code; on macOS the native module may need its folder on `DYLD_LIBRARY_PATH`.

## Troubleshooting

- **Download failed:** the bar and the settings row show the reason. Choose **Retry**; finished files are kept.
- **"Local dictation connection lost":** the engine stopped or could not load the model. Remove the model in Settings, download it again, and check `%APPDATA%\LearnHarness\logs\main.log`.
