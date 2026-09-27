/* ────────────────────────────────────────────────────────────────────────────
   Math (the formula editor): a LaTeX subset to MathML.

   MathML Core renders natively in Chrome, Edge, Safari and Firefox, so a
   formula needs no font or library -- just this translation. Supported:
   fractions, roots (with index), super/subscripts, big operators with limits
   (sum, prod, int, lim), Greek, common relations and arrows, \left...\right
   fences, \text, \mathbf/\mathit/\mathbb, accents (hat, bar, vec, dot), and
   matrices (matrix, pmatrix, bmatrix, vmatrix, cases).

   Every character that reaches the output is escaped, so a formula can never
   inject markup. Unknown commands render as their name in red, the way
   LibreOffice Math shows an error in place.

   PURE.
   ──────────────────────────────────────────────────────────────────────────── */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const GREEK: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ϵ", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ",
  iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", varpi: "ϖ", rho: "ρ", sigma: "σ", tau: "τ",
  upsilon: "υ", phi: "ϕ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
};

const OPS: Record<string, string> = {
  cdot: "⋅", times: "×", div: "÷", pm: "±", mp: "∓", leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠", approx: "≈", equiv: "≡",
  sim: "∼", propto: "∝", infty: "∞", partial: "∂", nabla: "∇", forall: "∀", exists: "∃", in: "∈", notin: "∉", subset: "⊂", subseteq: "⊆",
  supset: "⊃", cup: "∪", cap: "∩", emptyset: "∅", to: "→", rightarrow: "→", leftarrow: "←", Rightarrow: "⇒", Leftarrow: "⇐",
  leftrightarrow: "↔", Leftrightarrow: "⇔", mapsto: "↦", ldots: "…", cdots: "⋯", vdots: "⋮", ddots: "⋱", circ: "∘", ast: "∗",
  neg: "¬", land: "∧", lor: "∨", angle: "∠", perp: "⊥", parallel: "∥", degree: "°", prime: "′", hbar: "ℏ", ell: "ℓ",
  langle: "⟨", rangle: "⟩", lfloor: "⌊", rfloor: "⌋", lceil: "⌈", rceil: "⌉", quad: " ", qquad: "  ", ",": " ", ";": " ", "!": "",
};

const BIG: Record<string, string> = { sum: "∑", prod: "∏", int: "∫", iint: "∬", iiint: "∭", oint: "∮", bigcup: "⋃", bigcap: "⋂" };
const FUNCS = new Set(["sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "log", "ln", "exp", "lim", "max", "min", "sup", "inf", "det", "gcd", "deg", "dim", "ker", "arg"]);
const ACCENT: Record<string, string> = { hat: "^", bar: "¯", vec: "→", dot: "˙", ddot: "¨", tilde: "~", overline: "¯" };
const MATRIX: Record<string, [string, string]> = { matrix: ["", ""], pmatrix: ["(", ")"], bmatrix: ["[", "]"], vmatrix: ["|", "|"], Vmatrix: ["‖", "‖"], cases: ["{", ""] };

class P {
  i = 0;
  constructor(private s: string) {}
  peek() { return this.s[this.i]; }
  eof() { return this.i >= this.s.length; }
  ws() { while (!this.eof() && /\s/.test(this.s[this.i])) this.i++; }

  /** A sequence until `}` / end / `&` / `\\` / `\right` / `\end`. */
  seq(): string {
    const parts: string[] = [];
    for (;;) {
      this.ws();
      if (this.eof()) break;
      const c = this.peek();
      if (c === "}" || c === "&") break;
      if (this.s.startsWith("\\\\", this.i) || this.s.startsWith("\\right", this.i) || this.s.startsWith("\\end", this.i)) break;
      parts.push(this.scripted());
    }
    return parts.length === 1 ? parts[0] : `<mrow>${parts.join("")}</mrow>`;
  }

  /** An atom with optional ^ and _ in either order. */
  scripted(): string {
    const startCmd = /^\\([a-zA-Z]+)/.exec(this.s.slice(this.i))?.[1] ?? "";
    const base = this.atom();
    let sup: string | null = null, sub: string | null = null;
    for (;;) {
      this.ws();
      const c = this.peek();
      if (c === "^" && sup === null) { this.i++; sup = this.arg(); }
      else if (c === "_" && sub === null) { this.i++; sub = this.arg(); }
      else if (c === "'" && sup === null) { this.i++; sup = "<mo>′</mo>"; }
      else break;
    }
    const under = BIG[startCmd] !== undefined && startCmd !== "int" && startCmd !== "iint" && startCmd !== "iiint" && startCmd !== "oint" || startCmd === "lim" || startCmd === "max" || startCmd === "min";
    if (sup !== null && sub !== null) return under ? `<munderover>${base}${sub}${sup}</munderover>` : `<msubsup>${base}${sub}${sup}</msubsup>`;
    if (sup !== null) return under ? `<mover>${base}${sup}</mover>` : `<msup>${base}${sup}</msup>`;
    if (sub !== null) return under ? `<munder>${base}${sub}</munder>` : `<msub>${base}${sub}</msub>`;
    return base;
  }

  /** A single-token argument, or a {group}. */
  arg(): string {
    this.ws();
    if (this.peek() === "{") return this.group();
    if (this.peek() === "\\") return this.atom();
    const c = this.s[this.i++] ?? "";
    return /[0-9]/.test(c) ? `<mn>${esc(c)}</mn>` : /[A-Za-z]/.test(c) ? `<mi>${esc(c)}</mi>` : `<mo>${esc(c)}</mo>`;
  }

  group(): string {
    this.i++; // {
    const inner = this.seq();
    if (this.peek() === "}") this.i++;
    return inner || "<mrow/>";
  }

  rawGroup(): string {
    this.ws();
    if (this.peek() !== "{") return "";
    let depth = 0, out = "";
    for (; !this.eof(); this.i++) {
      const c = this.s[this.i];
      if (c === "{") { if (depth++ === 0) continue; }
      else if (c === "}") { if (--depth === 0) { this.i++; break; } }
      out += c;
    }
    return out;
  }

  fence(): string {
    this.ws();
    if (this.s.startsWith("\\{", this.i) || this.s.startsWith("\\}", this.i)) { this.i += 2; return this.s[this.i - 1]; }
    const m = /^\\(langle|rangle|lfloor|rfloor|lceil|rceil|vert|Vert)/.exec(this.s.slice(this.i));
    if (m) { this.i += m[0].length; return m[1] === "vert" ? "|" : m[1] === "Vert" ? "‖" : OPS[m[1]]; }
    const c = this.s[this.i++] ?? "";
    return c === "." ? "" : c;
  }

  atom(): string {
    this.ws();
    const c = this.peek();
    if (c === "{") return this.group();
    if (c !== "\\") {
      if (/[0-9.]/.test(c)) {
        const m = /^[0-9]*\.?[0-9]+|^[0-9]+/.exec(this.s.slice(this.i))!;
        this.i += m[0].length;
        return `<mn>${m[0]}</mn>`;
      }
      this.i++;
      if (/[A-Za-z]/.test(c)) return `<mi>${esc(c)}</mi>`;
      if (c === "~") return `<mspace width="0.3em"/>`;
      return `<mo>${esc(c)}</mo>`;
    }
    // A command.
    const m = /^\\([a-zA-Z]+|.)/.exec(this.s.slice(this.i));
    if (!m) { this.i++; return "<mo>\\</mo>"; }
    this.i += m[0].length;
    const name = m[1];
    if (name === "frac" || name === "dfrac" || name === "tfrac") return `<mfrac>${this.arg()}${this.arg()}</mfrac>`;
    if (name === "binom") return `<mrow><mo>(</mo><mfrac linethickness="0">${this.arg()}${this.arg()}</mfrac><mo>)</mo></mrow>`;
    if (name === "sqrt") {
      this.ws();
      if (this.peek() === "[") {
        this.i++;
        const idx: string[] = [];
        while (!this.eof() && this.peek() !== "]") idx.push(this.scripted());
        this.i++;
        return `<mroot>${this.arg()}<mrow>${idx.join("")}</mrow></mroot>`;
      }
      return `<msqrt>${this.arg()}</msqrt>`;
    }
    if (name in GREEK) return `<mi>${GREEK[name]}</mi>`;
    if (name in BIG) return `<mo largeop="true">${BIG[name]}</mo>`;
    if (name in OPS) return name === "quad" || name === "qquad" || name === "," || name === ";" ? `<mspace width="${name === "qquad" ? 2 : name === "quad" ? 1 : 0.25}em"/>` : `<mo>${OPS[name]}</mo>`;
    if (FUNCS.has(name)) return `<mi>${name}</mi>`;
    if (name in ACCENT) return `<mover accent="true">${this.arg()}<mo>${esc(ACCENT[name])}</mo></mover>`;
    if (name === "text" || name === "mathrm" || name === "operatorname") { const t = this.rawGroup(); return name === "text" ? `<mtext>${esc(t)}</mtext>` : `<mi mathvariant="normal">${esc(t)}</mi>`; }
    if (name === "mathbf") return `<mrow style="font-weight:bold">${this.arg().replace(/<mi>/g, '<mi mathvariant="bold">')}</mrow>`;
    if (name === "mathit") return this.arg();
    if (name === "mathbb") { const t = this.rawGroup(); const map: Record<string, string> = { R: "ℝ", N: "ℕ", Z: "ℤ", Q: "ℚ", C: "ℂ", P: "ℙ" }; return `<mi>${[...t].map((ch) => map[ch] ?? esc(ch)).join("")}</mi>`; }
    if (name === "left") {
      const open = this.fence();
      const inner = this.seq();
      let close = "";
      if (this.s.startsWith("\\right", this.i)) { this.i += 6; close = this.fence(); }
      return `<mrow>${open ? `<mo fence="true">${esc(open)}</mo>` : ""}${inner}${close ? `<mo fence="true">${esc(close)}</mo>` : ""}</mrow>`;
    }
    if (name === "begin") {
      const env = this.rawGroup();
      const rows: string[][] = [[]];
      for (;;) {
        rows[rows.length - 1].push(this.seq());
        if (this.eof()) break;
        if (this.peek() === "&") { this.i++; continue; }
        if (this.s.startsWith("\\\\", this.i)) { this.i += 2; rows.push([]); continue; }
        if (this.s.startsWith("\\end", this.i)) { this.i += 4; this.rawGroup(); break; }
        if (this.peek() === "}") { this.i++; continue; }
        break;
      }
      const [l, r] = MATRIX[env] ?? ["", ""];
      const table = `<mtable${env === "cases" ? ' columnalign="left"' : ""}>${rows.filter((row) => row.some((x) => x && x !== "<mrow></mrow>")).map((row) => `<mtr>${row.map((cell) => `<mtd>${cell}</mtd>`).join("")}</mtr>`).join("")}</mtable>`;
      return `<mrow>${l ? `<mo>${esc(l)}</mo>` : ""}${table}${r ? `<mo>${esc(r)}</mo>` : ""}</mrow>`;
    }
    if (name === "{" || name === "}" || name === "%" || name === "$" || name === "#" || name === "&" || name === "_") return `<mo>${esc(name)}</mo>`;
    return `<merror><mtext>\\${esc(name)}</mtext></merror>`;
  }
}

export function latexToMathML(src: string, opts: { display?: boolean } = {}): string {
  const p = new P(src.slice(0, 5000));
  let body = "";
  // Stray closers are shown, not silently eaten.
  while (!p.eof()) {
    body += p.seq();
    if (!p.eof()) { const c = p.peek(); p.i++; body += c === "&" ? "" : `<merror><mtext>${esc(c)}</mtext></merror>`; }
  }
  return `<math xmlns="http://www.w3.org/1998/Math/MathML"${opts.display ? ' display="block"' : ""}>${body}</math>`;
}

/** Commands the editor's palette offers, grouped. */
export const MATH_PALETTE: Array<{ group: string; items: Array<{ label: string; insert: string }> }> = [
  { group: "Structure", items: [{ label: "a/b", insert: "\\frac{a}{b}" }, { label: "√x", insert: "\\sqrt{x}" }, { label: "ⁿ√x", insert: "\\sqrt[n]{x}" }, { label: "xⁿ", insert: "x^{n}" }, { label: "xᵢ", insert: "x_{i}" }, { label: "( )", insert: "\\left( x \\right)" }] },
  { group: "Operators", items: [{ label: "∑", insert: "\\sum_{i=1}^{n}" }, { label: "∏", insert: "\\prod_{i=1}^{n}" }, { label: "∫", insert: "\\int_{a}^{b}" }, { label: "lim", insert: "\\lim_{x \\to \\infty}" }, { label: "±", insert: "\\pm" }, { label: "·", insert: "\\cdot" }] },
  { group: "Relations", items: [{ label: "≤", insert: "\\leq" }, { label: "≥", insert: "\\geq" }, { label: "≠", insert: "\\neq" }, { label: "≈", insert: "\\approx" }, { label: "→", insert: "\\to" }, { label: "∈", insert: "\\in" }] },
  { group: "Greek", items: ["alpha", "beta", "gamma", "delta", "theta", "lambda", "mu", "pi", "sigma", "phi", "omega", "Omega"].map((g) => ({ label: GREEK[g], insert: `\\${g}` })) },
  { group: "Matrices", items: [{ label: "( 2x2 )", insert: "\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}" }, { label: "cases", insert: "f(x) = \\begin{cases} 1 & x > 0 \\\\ 0 & \\text{otherwise} \\end{cases}" }] },
];
