# OS Assistant

<p align="center">
  <img src="docs/screenshots/chat.png" alt="Sticky, the default character, answering a question in the chat bubble" width="420">
</p>

A friendly character that floats on top of your desktop. Click it (or press the hotkey) to chat. Works with Claude, local Ollama models, or any OpenAI-compatible service, can open your apps, files and websites, and can use tools from MCP servers.

Runs on macOS and Windows. Built with Electron, React and TypeScript.

## Screenshots

<table>
  <tr>
    <td width="50%">
      <img src="docs/screenshots/ai-providers.png" alt="AI Providers settings">
      <p align="center"><b>AI providers</b>: Claude, Ollama, OpenAI, OpenRouter, Groq, OpenCode, LM Studio or any compatible URL</p>
    </td>
    <td width="50%">
      <img src="docs/screenshots/tools.png" alt="Tools settings">
      <p align="center"><b>Tools</b>: open apps, files and websites, plus MCP servers, each with its own approval setting</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="docs/screenshots/characters.png" alt="Characters settings">
      <p align="center"><b>Characters</b>: Bolt, Dr. Nova (scientist), Kage (ninja), Mochi, Pixel (geek) and Sticky built in, or add your own</p>
    </td>
    <td width="50%">
      <img src="docs/screenshots/tips.png" alt="Tips settings">
      <p align="center"><b>Tips</b>: daily greeting, break reminders, random tips and a clipboard helper</p>
    </td>
  </tr>
</table>

## Run it

```bash
npm install
npm run dev        # development, with hot reload
npm test           # unit tests
npm run typecheck
npm run dist:mac   # build a .dmg in dist/ (dist:win for Windows)
```

The app lives in the menu bar (tray). Default hotkey: **Option+Space** (Alt+Space on Windows).

## Using it

- **Click** the character to open the chat. **Drag** it anywhere; it remembers where you left it.
- Pick the model from the menu at the top of the chat bubble.
- **Settings** (gear icon or tray menu):
  - **AI Providers**: add your Claude API key, point Ollama at another host, or add OpenAI, OpenRouter, Groq, OpenCode, LM Studio or any OpenAI-compatible URL.
  - **Tools**: the built-in **Desktop** tools open apps (Word, Excel, browsers, code editors, calendar, Teams, Zoom…), files, websites and meeting/call links, find files by name, and show files in Finder/Explorer. Apps can be asked for by type ("a spreadsheet", "calendar", "video call"), and a missing app is swapped for a similar installed one (Excel → Numbers → LibreOffice → Google Sheets). The fallback lists are in `src/main/desktop/categories.ts`. These tools open apps but can't read what's inside them; use an MCP server for that. Add more tools from MCP servers by command (stdio) or URL, import them from Claude Desktop, or edit them as JSON. Each tool asks for approval first unless you set it to "Always allow".
  - **Characters**: switch characters, or add your own pack.
  - **Tips**: greeting, break reminders, random tips and the clipboard helper (off by default).

## Making a character

Put a folder in the characters folder (Settings → Characters → Open characters folder):

```
my-buddy/
  character.json
  idle.svg
  talk.gif
```

```json
{
  "id": "my-buddy",
  "name": "Buddy",
  "persona": "You are Buddy, a calm and witty helper.",
  "greeting": "Hey there! What's up?",
  "tips": ["Tip: Take a short walk every hour."],
  "size": { "width": 140, "height": 140 },
  "states": {
    "idle": "idle.svg",
    "talk": "talk.gif",
    "think": { "sheet": "think.png", "frameWidth": 140, "frameHeight": 140, "frames": 6, "fps": 10 }
  }
}
```

States: `idle` (required), `greet`, `listen`, `think`, `talk`, `tip`, `sleep`, `error`. Missing states fall back to similar ones, then to `idle`. Images can be animated SVG (CSS animations inside the SVG), GIF, APNG, WebP, or a horizontal sprite sheet.

## How it's built

| Part | Where |
| --- | --- |
| Floating window, layout, tray, hotkey | `src/main/windows.ts`, `layout.ts`, `tray.ts`, `index.ts` |
| Chat loop (tool calls, approvals, saving) | `src/main/chat/orchestrator.ts` |
| AI providers (one file each) | `src/main/providers/` |
| Built-in desktop tools (open apps, files, URLs) | `src/main/desktop/` |
| MCP client | `src/main/mcp/manager.ts` |
| Chat history (Electron's built-in SQLite) | `src/main/store/sqliteStore.ts` |
| Tips | `src/main/tips/engine.ts` |
| UI (React) | `src/renderer/src/` |
| Built-in characters | `resources/characters/` |

To add a new AI service, implement `ChatProvider` (`src/main/providers/types.ts`) and register it in `src/main/providers/index.ts`.

Your chats, settings and character packs are stored in the app's data folder (`~/Library/Application Support/OS Assistant` on macOS). API keys are encrypted with the system keychain.
