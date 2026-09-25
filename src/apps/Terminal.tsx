"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { useVFS } from "@/kernel/vfs";
import { bus } from "@/kernel/bus";
import { registerContextTarget } from "@/kernel/ctxmenu";
import {
  tokenize, splitPipeline, complete, parseFlags, grepText, wcText, headText, tailText, sortText, treeText, globMatch, resolvePath,
} from "@/lib/shellparse";
import { planTrash, isTrashed } from "@/lib/vfsops";
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
type Print = (text: string, kind?: Line["kind"]) => void;

/** Command history survives a reload — the thing a shell user misses first. */
const useTermHistory = create<{ items: string[]; push: (l: string) => void; clear: () => void }>()(
  persist(
    (set) => ({
      items: [],
      // Newest first; an immediate repeat is not stored twice.
      push: (l) => set((s) => ({ items: s.items[0] === l ? s.items : [l, ...s.items].slice(0, 500) })),
      clear: () => set({ items: [] }),
    }),
    { name: "webaios.terminal.history.v1", storage: createJSONStorage(() => localStorage) },
  ),
);

const COMMANDS = [
  "help", "ls", "cd", "pwd", "cat", "write", "rm", "find", "du", "grep", "wc", "head", "tail", "sort", "tree",
  "apps", "open", "close", "windows", "profile", "theme", "set", "wallpaper",
  "ask", "ai", "model", "provider", "budget", "clear", "echo", "date", "whoami", "export", "reset", "history",
];

export default function Terminal({}: AppProps) {
  const vfs = useVFS();
  const wm = useWM();
  const settings = useSettings();
  const [lines, setLines] = useState<Line[]>([
    { kind: "sys", text: "Web-AIOS shell. Type `help` for commands." },
  ]);
  const [input, setInput] = useState("");
  const history = useTermHistory((st) => st.items);
  const pushHistory = useTermHistory((st) => st.push);
  const [histIdx, setHistIdx] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
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
    // Handles ".", "..", "../x" and absolute paths (src/lib/shellparse.ts).
    return resolvePath(cwd, p);
  }, [cwd]);

  /** Read a file argument, or fall back to piped input when there is none. */
  const input1 = useCallback((file: string | undefined, stdin: string | null, print: Print, cmd: string): string | null => {
    if (file) {
      const n = vfs.read(resolve(file));
      if (!n) { print(`${cmd}: ${file}: no such file`, "err"); return null; }
      return n.content;
    }
    if (stdin !== null) return stdin;
    print(`${cmd}: no input (give a file, or pipe into it)`, "err");
    return null;
  }, [vfs, resolve]);

  /** One pipeline stage. `stdin` is the previous stage's output, or null. */
  const exec = useCallback(
    async (line: string, stdin: string | null, print: Print) => {
      const [cmd = "", ...args] = tokenize(line);
      const rest = line.slice(line.indexOf(cmd) + cmd.length).trim();

      switch (cmd) {
        case "help":
          print([
            "Filesystem   ls [-a] [dir]   cd <dir>   pwd   cat <file>   write <file> <text>   rm <file> (to trash)   du",
            "             find <query>   find -name <glob> [dir]   tree [dir]",
            "Text         grep [-i -v -c -n] <pattern> [file]   wc [-l -w -c] [file]   head/tail [-n N] [file]   sort [-r -n -u] [file]",
            "Pipes        cat /notes/a.md | grep -i todo | wc -l      Tab completes commands and paths; Up/Down walk history",
            "Apps         apps   open <app> [prompt]   close <app>   windows",
            "Appearance   profile [id]   theme [id]   set <key> <value>   wallpaper <id>",
            "AI           ask <prompt>   ai <prompt> (plain answer; pipe text in as context)   model [id]   provider [id]   budget [usd]",
            "System       clear   echo <text>   date   whoami   export   reset   history [-c]",
          ].join("\n"));
          break;

        case "ls": {
          const lf = parseFlags(args);
          const dir = resolve(lf.rest[0] ?? "");
          const prefix = dir === "/" ? "/" : `${dir}/`;
          const seen = new Set<string>();
          const rows: string[] = [];
          for (const n of Object.values(vfs.nodes)) {
            if (!n.path.startsWith(prefix)) continue;
            const tail = n.path.slice(prefix.length);
            const seg = tail.split("/")[0];
            if (!seg || seen.has(seg)) continue;
            // Dot-entries (the trash) are hidden unless asked for, as in any shell.
            if (seg.startsWith(".") && !lf.flags.has("a")) continue;
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
          if (!args[0] && stdin !== null) { print(stdin); break; }
          const n = vfs.read(resolve(args[0] ?? ""));
          if (!n) print(`cat: ${args[0]}: no such file`, "err");
          else print(n.content || "(empty file)");
          break;
        }
        case "pwd": print(cwd); break;
        case "write": {
          const [file, ...text] = args;
          if (!file) { print("usage: write <file> <text>", "err"); break; }
          const p = resolve(file);
          vfs.write(p, text.join(" "), { appId: "terminal" });
          print(`wrote ${p}`);
          break;
        }
        case "rm": {
          // Soft delete: rm moves to the trash, restorable from Files > Trash.
          const p = resolve(args[0] ?? "");
          if (!vfs.read(p)) { print(`rm: ${args[0]}: no such file`, "err"); break; }
          const plan = planTrash(Object.keys(vfs.nodes), p, Date.now());
          if (!plan.ok) { print(`rm: ${plan.reason}`, "err"); break; }
          for (const [a, b] of plan.pairs) vfs.rename(a, b);
          print(`moved ${p} to the trash (restore it from Files > Trash)`);
          break;
        }
        case "find": {
          if (args[0] === "-name") {
            const glob = args[1] ?? "*";
            const root = resolve(args[2] ?? "");
            const prefix = root === "/" ? "/" : root + "/";
            const found = Object.keys(vfs.nodes).filter((p) => p.startsWith(prefix) && !isTrashed(p) && globMatch(p.split("/").pop() ?? "", glob)).sort();
            print(found.length ? found.join("\n") : "no matches");
            break;
          }
          const hits = vfs.search(rest).filter((h) => !isTrashed(h.path));
          print(hits.length ? hits.map((h) => `${h.path}  (${bytes(h.size)})`).join("\n") : "no matches");
          break;
        }
        case "du": {
          const u = vfs.usage();
          print(`${u.count} files, ${bytes(u.bytes)} used in browser storage`);
          break;
        }

        case "grep": {
          const g = parseFlags(args);
          const [pattern, file] = g.rest;
          if (pattern === undefined) { print("usage: grep [-i -v -c -n] <pattern> [file]", "err"); break; }
          const text = input1(file, stdin, print, "grep");
          if (text === null) break;
          const out = grepText(text, pattern, { ignoreCase: g.flags.has("i"), invert: g.flags.has("v"), count: g.flags.has("c"), lineNumbers: g.flags.has("n") });
          print(out);
          break;
        }
        case "wc": {
          const w = parseFlags(args);
          const text = input1(w.rest[0], stdin, print, "wc");
          if (text === null) break;
          const c = wcText(text);
          if (w.flags.has("l")) print(String(c.lines));
          else if (w.flags.has("w")) print(String(c.words));
          else if (w.flags.has("c")) print(String(c.chars));
          else print(`${c.lines} lines  ${c.words} words  ${c.chars} chars`);
          break;
        }
        case "head":
        case "tail": {
          const h = parseFlags(args, ["n"]);
          const n = Number(h.values.n ?? 10);
          if (!Number.isFinite(n) || n < 0) { print(`${cmd}: bad count "${h.values.n}"`, "err"); break; }
          const text = input1(h.rest[0], stdin, print, cmd);
          if (text === null) break;
          print(cmd === "head" ? headText(text, n) : tailText(text, n));
          break;
        }
        case "sort": {
          const so = parseFlags(args);
          const text = input1(so.rest[0], stdin, print, "sort");
          if (text === null) break;
          print(sortText(text, { reverse: so.flags.has("r"), numeric: so.flags.has("n"), unique: so.flags.has("u") }));
          break;
        }
        case "tree": {
          const root = resolve(args[0] ?? "");
          const t = treeText(Object.keys(vfs.nodes).filter((p) => !isTrashed(p)), root);
          print(`${t.text}\n\n${t.dirs} director${t.dirs === 1 ? "y" : "ies"}, ${t.files} file${t.files === 1 ? "" : "s"}`);
          break;
        }
        case "history": {
          if (args[0] === "-c") { useTermHistory.getState().clear(); print("history cleared"); break; }
          const items = [...useTermHistory.getState().items].reverse();
          print(items.length ? items.map((h, i) => `${String(i + 1).padStart(4)}  ${h}`).join("\n") : "(no history)");
          break;
        }
        case "ai": {
          // A plain, persona-free answer that pipes well: `cat notes/x.md | ai summarize`.
          if (!rest && stdin === null) { print("usage: ai <prompt>   (or pipe text in: cat file | ai summarize)", "err"); break; }
          setBusy(true);
          try {
            const res = await ask({
              messages: [{ role: "user", content: stdin !== null ? `${rest || "Summarize this."}\n\n---\n\n${stdin.slice(0, 30000)}` : rest }],
              system: "You are answering inside a terminal. Reply in plain text with no markdown formatting, as briefly as the question allows.",
              persona: false,
              maxTokens: 1200,
            });
            print(res.text.trim() || "(empty reply)");
          } catch (e) {
            print(`ai: ${e instanceof Error ? e.message : "request failed"}`, "err");
          } finally { setBusy(false); }
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
    [cwd, vfs, wm, settings, resolve, input1, lines.length],
  );

  /** Run a line: split on unquoted pipes, feed each stage the previous
   *  stage's output, print only the last stage (and every error). */
  const run = useCallback(
    async (raw: string) => {
      const line = raw.trim();
      if (!line) return;
      print(`${cwd} $ ${line}`, "in");
      pushHistory(line);
      setHistIdx(-1);

      const pipe = splitPipeline(line);
      if (!pipe.ok) { print(`shell: ${pipe.reason}`, "err"); return; }
      let stdin: string | null = null;
      for (let i = 0; i < pipe.stages.length; i++) {
        const last = i === pipe.stages.length - 1;
        if (last) { await exec(pipe.stages[i], stdin, print); break; }
        const buf: string[] = [];
        let failed = false;
        await exec(pipe.stages[i], stdin, (text, kind = "out") => {
          if (kind === "err") { failed = true; print(text, "err"); }
          else buf.push(text);
        });
        if (failed) return;
        stdin = buf.join("\n");
      }
    },
    [cwd, print, pushHistory, exec],
  );

  const tabComplete = useCallback(() => {
    const paths = Object.keys(vfs.nodes).filter((p) => !isTrashed(p));
    const c = complete(input, COMMANDS, paths, cwd);
    if (c.options.length > 1) print(c.options.join("   "), "sys");
    setInput(c.line);
  }, [vfs.nodes, input, cwd, print]);

  /* Right-click: copy (selection, or all output), paste, clear. */
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    return registerContextTarget(el, () => ({
      id: "terminal",
      entries: [
        { id: "copy", label: "Copy output", icon: "copy", run: () => {
          const sel = window.getSelection()?.toString();
          const text = sel || lines.map((l) => l.text).join("\n");
          navigator.clipboard.writeText(text).then(
            () => bus.emit("notify", { title: sel ? "Selection copied" : "Terminal output copied", kind: "success" }),
            () => bus.emit("notify", { title: "The browser refused clipboard access", kind: "warn" }),
          );
        } },
        { id: "paste", label: "Paste", icon: "claim", run: () => {
          navigator.clipboard.readText().then(
            (t) => { setInput((v) => v + t.replace(/\r?\n/g, " ")); inputRef.current?.focus(); },
            () => bus.emit("notify", { title: "The browser refused clipboard access — use the keyboard shortcut", kind: "warn" }),
          );
        } },
        { id: "clear", label: "Clear", icon: "close", run: () => setLines([]) },
      ],
    }));
  }, [lines]);

  return (
    <div
      ref={rootRef}
      className="flex h-full flex-col font-[family-name:var(--font-mono)] text-[12.5px]"
      onClick={() => { if (!window.getSelection()?.toString()) inputRef.current?.focus(); }}
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
            else if (e.key === "Tab") { e.preventDefault(); tabComplete(); }
            else if (e.key === "l" && e.ctrlKey) { e.preventDefault(); setLines([]); }
            else if (e.key === "ArrowUp") { e.preventDefault(); const n = Math.min(histIdx + 1, history.length - 1); if (n >= 0) { setHistIdx(n); setInput(history[n]); } }
            else if (e.key === "ArrowDown") { e.preventDefault(); const n = histIdx - 1; setHistIdx(n); setInput(n >= 0 ? history[n] : ""); }
          }}
          disabled={busy}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          aria-label="Terminal command"
          className="flex-1 bg-transparent outline-none disabled:opacity-50"
          style={{ fontSize: 16 }}
          placeholder={busy ? "working…" : ""}
        />
      </div>
    </div>
  );
}
