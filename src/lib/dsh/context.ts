/**
 * dsh-lite plugin context. A browser re-implementation (NOT vendored code) of
 * the part of Cordis that DeepSeek Harness relies on, per its
 * docs/architecture.md: plugins contribute services, typed events and
 * reversible effects to a shared context.
 *
 *  - Every registration (service, serial listener, waterfall listener) is an
 *    effect that returns a disposer, and is also recorded against the plugin
 *    that made it. Unloading a plugin runs every disposer it owns, newest
 *    first, so nothing it registered survives it.
 *  - Serial events run listeners in order and collect their return values.
 *  - Waterfall events hand each listener `(payload, next)`. A listener
 *    delegates by calling `next(payload)`; it may also intercept by returning
 *    a value without calling next. A listener that does neither (returns
 *    undefined and never called next) is a bug, and throws rather than
 *    silently swallowing the call: "listeners must call next() to delegate".
 *
 * Pure: no DOM, no clock.
 */

export type Disposer = () => void;
export type SerialListener<P = unknown, R = unknown> = (payload: P) => R | Promise<R>;
export type WaterfallListener<P = unknown, R = unknown> = (payload: P, next: (payload: P) => Promise<R>) => R | Promise<R>;

export interface DshPlugin {
  name: string;
  description: string;
  /** Core plugins cannot be unloaded from the UI (the log, the tool registry). */
  required?: boolean;
  apply(ctx: DshContext): void;
}

export class DshWaterfallError extends Error {
  constructor(event: string, index: number) {
    super(`waterfall "${event}": listener #${index} neither called next() nor returned a value`);
    this.name = "DshWaterfallError";
  }
}

interface Owned { plugin: string; dispose: Disposer; kind: string; label: string }

export class DshContext {
  private services = new Map<string, unknown>();
  private serial = new Map<string, Array<SerialListener<never, unknown>>>();
  private waterfalls = new Map<string, Array<WaterfallListener<never, unknown>>>();
  private effects: Owned[] = [];
  private plugins = new Map<string, DshPlugin>();
  private current: string | null = null;

  /** Load a plugin. Registrations made during apply() are owned by it. */
  plugin(p: DshPlugin): Disposer {
    if (this.plugins.has(p.name)) return () => this.unload(p.name);
    const prev = this.current;
    this.current = p.name;
    this.plugins.set(p.name, p);
    try {
      p.apply(this);
    } catch (e) {
      this.current = prev;
      this.unload(p.name);
      throw e;
    }
    this.current = prev;
    return () => this.unload(p.name);
  }

  /** Unwind everything a plugin registered, newest first. */
  unload(name: string): boolean {
    if (!this.plugins.has(name)) return false;
    const mine = this.effects.filter((e) => e.plugin === name);
    for (const e of mine.reverse()) e.dispose();
    this.effects = this.effects.filter((e) => e.plugin !== name);
    this.plugins.delete(name);
    return true;
  }

  loaded(): DshPlugin[] { return [...this.plugins.values()]; }
  isLoaded(name: string): boolean { return this.plugins.has(name); }
  /** What each plugin currently owns, for the plugin manager. */
  effectsOf(name: string): Array<{ kind: string; label: string }> {
    return this.effects.filter((e) => e.plugin === name).map(({ kind, label }) => ({ kind, label }));
  }
  /** Total live registrations, so a test can prove an unload leaked nothing. */
  registrationCount(): number {
    let n = this.services.size;
    for (const l of this.serial.values()) n += l.length;
    for (const l of this.waterfalls.values()) n += l.length;
    return n;
  }

  private own(kind: string, label: string, dispose: Disposer): Disposer {
    let done = false;
    const once = () => {
      if (done) return;
      done = true;
      dispose();
      this.effects = this.effects.filter((e) => e.dispose !== once);
    };
    this.effects.push({ plugin: this.current ?? "(root)", dispose: once, kind, label });
    return once;
  }

  provide<T>(name: string, service: T): Disposer {
    if (this.services.has(name)) throw new Error(`service "${name}" is already provided`);
    this.services.set(name, service);
    return this.own("service", name, () => { if (this.services.get(name) === service) this.services.delete(name); });
  }
  get<T>(name: string): T | undefined { return this.services.get(name) as T | undefined; }

  on<P, R>(event: string, listener: SerialListener<P, R>): Disposer {
    const list = this.serial.get(event) ?? [];
    list.push(listener as unknown as SerialListener<never, unknown>);
    this.serial.set(event, list);
    return this.own("event", event, () => {
      const l = this.serial.get(event);
      if (!l) return;
      const i = l.indexOf(listener as unknown as SerialListener<never, unknown>);
      if (i >= 0) l.splice(i, 1);
      if (!l.length) this.serial.delete(event);
    });
  }

  waterfall<P, R>(event: string, listener: WaterfallListener<P, R>): Disposer {
    const list = this.waterfalls.get(event) ?? [];
    list.push(listener as unknown as WaterfallListener<never, unknown>);
    this.waterfalls.set(event, list);
    return this.own("waterfall", event, () => {
      const l = this.waterfalls.get(event);
      if (!l) return;
      const i = l.indexOf(listener as unknown as WaterfallListener<never, unknown>);
      if (i >= 0) l.splice(i, 1);
      if (!l.length) this.waterfalls.delete(event);
    });
  }

  /** Serial emit: every listener in order, results collected. */
  async emit<P, R = unknown>(event: string, payload: P): Promise<R[]> {
    const out: R[] = [];
    for (const l of [...(this.serial.get(event) ?? [])]) out.push(await (l as SerialListener<P, R>)(payload));
    return out;
  }

  /** Run a waterfall ending in `terminal`. */
  async run<P, R>(event: string, payload: P, terminal: (payload: P) => Promise<R>): Promise<R> {
    const list = [...(this.waterfalls.get(event) ?? [])] as unknown as Array<WaterfallListener<P, R>>;
    const step = async (i: number, p: P): Promise<R> => {
      if (i >= list.length) return terminal(p);
      let called = false;
      const next = (np: P) => { called = true; return step(i + 1, np); };
      const r = await list[i](p, next);
      if (!called && r === undefined) throw new DshWaterfallError(event, i);
      return r;
    };
    return step(0, payload);
  }
}
