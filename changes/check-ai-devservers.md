### Added

- **`kit check` warns when an AI dev server's default port listens beyond loopback.** The exposure
  check covered Ollama only. A new row reads this machine's listener table, as the Ollama row does,
  for LM Studio (1234), vLLM and other OpenAI-compatible servers (8000), ComfyUI (8188), Gradio
  (7860), Jupyter (8888) and the MCP Inspector (6274, 6277), and warns (medium) per port bound to
  anything other than 127.0.0.1 or `::1`. It runs no shell: `/proc/net/tcp` on Linux, then `ss` or
  `netstat`; `netstat` on macOS and Windows. It connects to nothing and matches the port, not the
  process. Found in kit-research `huginn-honeypot-vs-kit`: scanners probe these tools' defaults.
