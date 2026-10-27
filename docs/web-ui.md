# The web UI

Open `http://localhost:3000`. The UI is plain HTML and ES modules
(`index.html`, `script.js`, `ui/`), and every library is vendored, so there is
no build step.

## Tabs

The **top bar** has five tabs. The URL hash follows the current view, so the
browser's back button works.

| Tab | Shows |
|---|---|
| **Chat** (`#interactive`) | The dashboard's own chat with the loaded model. See [Chat](#chat). |
| **Monitor** (`#monitor`) | Live data for this browser session only. See [Monitor](#monitor). |
| **History** (`#history`) | Every recorded request, read from the CSV file and the SQLite database together. See [History](#history). |
| **Bench** (`#bench`) | Speed benchmarking: `llama-bench`, launch sweeps and public suites. Each has its own output pane and leaderboard. See [benchmarking.md](benchmarking.md). |
| **Results** (`#results`) | The model catalog. See [Results](#results). |

The top bar also has buttons that collapse the left and right sidebars, and a
pencil icon that opens the [posts editor](#posts-editor).

### Monitor

Monitor shows:

- a card for each running server;
- a "session activity" chart;
- prefill and generation t/s per server, as stacked charts;
- a table of requests.

Click a request row to see its launch config and a hardware chart for that
request alone.

### History

History has:

- a time-window chart you can pan, set to "last 24 h" or "all";
- a table of requests, grouped into runs, which loads older runs on demand.

### Results

Results has three kinds of page:

- **Overview boards** across all models.
- **A page per model,** with Speed, Quality, History, Tunings and Sources tabs.
- **Side-by-side comparisons** of two models.

Speed figures are per launch config and context depth, and include
prefill-vs-context curves.

GGUF files are identified by their content, so:

- a renamed or moved file keeps its history;
- two different files with the same name stay separate.

## Chat

The chat composer offers:

- **Attachments:** image, audio or video, when the model has an mmproj.
- **Thinking level per request:** template default, xhigh, medium, low or off.
  It is sent through `chat_template_kwargs`.
- **A show/hide-thinking toggle.**
- **A system prompt** and extra template kwargs.
- **A "web calls" count** for the web tools: 0 = off, N = up to N per answer,
  -1 = unlimited.

The web tools run on the server:

- `web_search` is a keyless DuckDuckGo search.
- `web_fetch` reads a public page as markdown. Its safety limits are in the
  [README](../README.md#the-web-fetch-tool).

Other behavior:

- Each answer has a small chart of the hardware while it was being generated.
- Saved chats are kept in the browser's local storage.
- "View logs (CSV)" opens the request CSV in a table.

The chat sends requests through `POST /api/chat`, a thin proxy to the model's
`/v1/chat/completions`. Like every other request, they are recorded.

## Left sidebar: launching

The top of the sidebar holds the main launch choices:

- the engine (`llama-server` or Strata);
- saved profiles and the model picker;
- a Hugging Face search;
- the build;
- the [device table](launching-models.md#devices-an-ordered-list);
- the split mode;
- once a worker is enabled, a transport label (LAN, Thunderbolt or internet).
  It is recorded with each request.

Below those are collapsible groups. Each group's header shows a one-line
summary of its settings:

- **Strata config** (see [launching-models.md](launching-models.md#strata-engine-optional))
- **Runtime:** context, GPU layers, KV cache types, MoE CPU layers, flash
  attention
- **Speculative decoding**
- **Sampling**
- **Template & vision**
- **Advanced:** extra arguments, the flag reference (parsed from the selected
  build's `--help`), and the launch-command preview

The footer has:

- Save profile and Load model;
- a boot timer;
- past averages for the selected model.

Below the footer are the server logs, for the master and the workers.

## Right sidebar: telemetry

- prefill and generation t/s, broken down by server
- context-window fill
- VRAM per GPU and RAM per host
- network and t/s sparklines
- GPU temperature, power and utilization
- CPU utilization and temperature

There is one line and one bar per physical card, and each card keeps the same
color everywhere. Click any chart to open it full screen over a time window you
can pan. The poll rate is 0.5, 1 or 2 s.

## Posts editor

The pencil icon opens `/posts`. It edits the markdown posts and the home-page
text of the [public results site](public-site.md#posts). It sits behind the
same password gate as the rest of the dashboard.
