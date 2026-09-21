"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useVFS } from "@/kernel/vfs";
import { useWM } from "@/kernel/wm";
import { useSettings } from "@/kernel/settings";
import { APPS, getApp } from "@/kernel/registry";
import { PROFILES } from "@/kernel/profiles";
import { allThemes } from "@/kernel/customthemes";
import { ask } from "@/lib/useAI";
import type { AppProps } from "@/kernel/types";
import { bytes } from "@/lib/format";

/** Terminal — a real shell over the OS, not a decorative prompt.
 *
 *  Commands reach the same stores every app uses, so `write`, `open`, `theme`
 *  and `profile` genuinely change the running system. `ask` pipes a prompt to
 *  the current model, which makes the terminal the fastest AI surface here. */
interface Line { kind: "in" | "out" | "err" | "sys"; text: string }

export default function Terminal({}: AppProps) {
  const vfs = useVFS();
  const wm = useWM();
  const settings = useSettings();
  const [lines, setLines] = useState<Line[]>([
    { kind: "sys", text: "Web-AIOS shell. Type `help` for commands." },
  ]);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const [cwd, setCwd] = useState("/");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [lines]);

  const print = useCallback((text: string, kind: Line["kind"] = "out") => {
    setLines((l) => [...l, { kind, text }]);
  }, []);

  const resolve = useCallback((p: string) => {
    if (!p) return cwd;
    if (p.startsWith("/")) return p.replace(/\/+$/, "") || "/";
    if (p === "..") return cwd.split("/").slice(0, -1).join("/") || "/";
    return `${cwd === "/" ? "" : cwd}/${p}`;
  }, [cwd]);

  const run = useCallback(
    async (raw: string) => {
      const line = raw.trim();
      if (!line) return;
      print(`${cwd} $ ${line}`, "in");
      setHistory((h) => [line, ...h].slice(0, 200));
      setHistIdx(-1);

      const [cmd, ...args] = line.split(/\s+/);
      const rest = line.slice(cmd.length).trim();

      switch (cmd) {
        case "help":
          print([
            "Filesystem   ls [dir]   cd <dir>   cat <file>   write <file> <text>   rm <file>   find <query>   du",
            "Apps         apps   open <app> [prompt]   close <app>   windows",
            "Appearance   profile [id]   theme [id]   set <key> <value>   wallpaper <id>",
            "AI           ask <prompt>   model [id]   provider [id]   budget [usd]",
            "System       clear   echo <text>   date   whoami   export   reset",
          ].join("\n"));
          break;

        case "ls": {
          const dir = resolve(args[0] ?? "");
          const prefix = dir === "/" ? "/" : `${dir}/`;
          const seen = new Set<string>();
          const rows: string[] = [];
          for (const n of Object.values(vfs.nodes)) {
            if (!n.path.startsWith(prefix)) continue;
            const tail = n.path.slice(prefix.length);
            const seg = tail.split("/")[0];
            if (!seg || seen.has(seg)) continue;
            seen.add(seg);
            rows.push(tail.includes("/") ? `${seg}/` : `${seg.padEnd(34)} ${bytes(n.size)}`);
          }
          print(rows.length ? rows.sort().join("\n") : "(empty)");
          break;
        }
        case "cd": {
          const dir = resolve(args[0] ?? "/");
          const exists = dir === "/" || Object.keys(vfs.nodes).some((p) => p.startsWith(dir + "/") || p === dir);
          if (!exists) print(`cd: no such directory: ${dir}`, "err");
          else setCwd(dir);
          break;
        }
        case "cat": {
          const n = vfs.read(resolve(args[0] ?? ""));
          if (!n) print(`cat: ${args[0]}: no such file`, "err");
          else print(n.content || "(empty file)");
          break;
        }
        case "write": {
          const [file, ...text] = args;
          if (!file) { print("usage: write <file> <text>", "err"); break; }
          const p = resolve(file);
          vfs.write(p, text.join(" "), { appId: "terminal" });
          print(`wrote ${p}`);
          break;
        }
        case "rm": {
          const p = resolve(args[0] ?? "");
          if (!vfs.read(p)) { print(`rm: ${args[0]}: no such file`, "err"); break; }
          vfs.remove(p);
          print(`removed ${p}`);
          break;
        }
        case "find": {
          const hits = vfs.search(rest);
          print(hits.length ? hits.map((h) => `${h.path}  (${bytes(h.size)})`).join("\n") : "no matches");
          break;
        }
        case "du": {
          const u = vfs.usage();
          print(`${u.count} files, ${bytes(u.bytes)} used in browser storage`);
          break;
        }

        case "apps":
          print(APPS.map((a) => `${a.id.padEnd(13)} ${a.name.padEnd(18)} ${a.description}`).join("\n"));
          break;
        case "open": {
          const app = getApp(args[0] ?? "");
          if (!app) { print(`open: unknown app "${args[0]}". Try \`apps\`.`, "err"); break; }
          const prompt = line.slice(line.indexOf(args[0]) + args[0].length).trim();
          wm.open(app.id, { title: app.name, icon: app.icon, size: app.defaultSize, singleton: app.singleton, args: prompt ? { prompt } : undefined });
          print(`opened ${app.name}`);
          break;
        }
        case "close": {
          const app = getApp(args[0] ?? "");
          if (!app) { print(`close: unknown app "${args[0]}"`, "err"); break; }
          wm.closeApp(app.id);
          print(`closed ${app.name}`);
          break;
        }
        case "windows":
          print(wm.windows.length
            ? wm.windows.map((w) => `${w.icon} ${w.title.padEnd(24)} ws${w.workspace}  ${w.state}`).join("\n")
            : "no windows open");
          break;

        case "profile": {
          if (!args[0]) { print(PROFILES.map((p) => `${p.id.padEnd(12)} ${p.name.padEnd(22)} ${p.lineage}`).join("\n")); break; }
          if (!PROFILES.some((p) => p.id === args[0])) { print(`unknown profile "${args[0]}"`, "err"); break; }
          settings.applyProfile(args[0]);
          print(`applied profile ${args[0]}`);
          break;
        }
        case "theme": {
          if (!args[0]) { print(allThemes().map((t) => `${t.id.padEnd(12)} ${t.name}`).join("\n")); break; }
          if (!allThemes().some((t) => t.id === args[0])) { print(`unknown theme "${args[0]}"`, "err"); break; }
          settings.applyTheme(args[0]);
          print(`applied theme ${args[0]}`);
          break;
        }
        case "wallpaper":
          settings.set("wallpaper", args[0] as never);
          print(`wallpaper: ${args[0]}`);
          break;
        case "set": {
          const [key, ...v] = args;
          const value = v.join(" ");
          if (!key) { print("usage: set <key> <value>", "err"); break; }
          const num = Number(value);
          const parsed = value === "true" ? true : value === "false" ? false : Number.isFinite(num) && value !== "" ? num : value;
          settings.patch({ [key]: parsed } as never);
          print(`${key} = ${String(parsed)}`);
          break;
        }

        case "ask": {
          if (!rest) { print("usage: ask <prompt>", "err"); break; }
          setBusy(true);
          const idx = lines.length + 1;
          print("", "out");
          try {
            await ask({
              messages: [{ role: "user", content: rest }],
              onDelta: (_d, full) => setLines((l) => l.map((x, i) => (i === idx ? { kind: "out", text: full } : x))),
            });
          } catch (e) {
            print(e instanceof Error ? e.message : "request failed", "err");
          } finally { setBusy(false); }
          break;
        }
        case "model":
          if (args[0]) { settings.setAI("model", args[0]); print(`model = ${args[0]}`); }
          else print(`model = ${settings.ai.model}`);
          break;
        case "provider":
          if (args[0]) { settings.setAI("provider", args[0]); print(`provider = ${args[0]}`); }
          else print(`provider = ${settings.ai.provider}`);
          break;
        case "budget":
          if (args[0]) { settings.setAI("budgetUsd", Number(args[0])); print(`budget = $${args[0]}`); }
          else print(`spent $${settings.ai.spentUsd.toFixed(4)} of $${settings.ai.budgetUsd.toFixed(2)}`);
          break;

        case "clear": setLines([]); break;
        case "echo": print(rest); break;
        case "date": print(new Date().toString()); break;
        case "whoami": print("you — everything here runs in your browser"); break;
        case "export": print(settings.exportProfile()); break;
        case "reset":
          if (args[0] === "--yes") { settings.reset(); print("settings reset to defaults"); }
          else print("This resets all personalization. Run `reset --yes` to confirm.", "err");
          break;

        default:
          print(`${cmd}: command not found. Try \`help\`.`, "err");
      }
    },
    [cwd, vfs, wm, settings, print, resolve, lines.length],
  );

  return (
    <div
      className="flex h-full flex-col font-[family-name:var(--font-mono)] text-[12.5px]"
      onClick={() => inputRef.current?.focus()}
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-2.5 leading-relaxed">
        {lines.map((l, i) => (
          <pre
            key={i}
            className="whitespace-pre-wrap break-words"
            style={{ color: l.kind === "err" ? "var(--danger)" : l.kind === "in" ? "var(--accent)" : l.kind === "sys" ? "var(--muted)" : "inherit" }}
          >
            {l.text}
          </pre>
        ))}
        <div ref={endRef} />
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-[var(--border)] px-2.5 py-2">
        <span className="shrink-0 text-[var(--accent)]">{cwd} $</span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !busy) { run(input); setInput(""); }
            else if (e.key === "ArrowUp") { e.preventDefault(); const n = Math.min(histIdx + 1, history.length - 1); if (n >= 0) { setHistIdx(n); setInput(history[n]); } }
            else if (e.key === "ArrowDown") { e.preventDefault(); const n = histIdx - 1; setHistIdx(n); setInput(n >= 0 ? history[n] : ""); }
          }}
          disabled={busy}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          className="flex-1 bg-transparent outline-none disabled:opacity-50"
          style={{ fontSize: 16 }}
          placeholder={busy ? "working…" : ""}
        />
      </div>
    </div>
  );
}
