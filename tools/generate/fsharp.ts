// F# lexical helpers shared by the generator.

const KEYWORDS = new Set([
    "abstract", "and", "as", "assert", "base", "begin", "class", "default", "delegate", "do", "done",
    "downcast", "downto", "elif", "else", "end", "exception", "extern", "false", "finally", "fixed",
    "for", "fun", "function", "global", "if", "in", "inherit", "inline", "interface", "internal",
    "lazy", "let", "match", "member", "module", "mutable", "namespace", "new", "not", "null", "of",
    "open", "or", "override", "private", "public", "rec", "return", "select", "sig", "static",
    "struct", "then", "to", "true", "try", "type", "upcast", "use", "val", "void", "when", "while",
    "with", "yield", "const", "fixed", "break", "checked", "component", "constraint", "continue",
    "event", "external", "include", "mixin", "parallel", "process", "protected", "pure", "sealed",
    "tailcall", "trait", "virtual", "atomic", "constructor", "eager", "functor", "measure", "method",
    "object", "params", "base", "asr", "land", "lor", "lsl", "lsr", "lxor", "mod",
]);

/** An identifier F# will accept, backticked when it is a keyword or not a plain identifier. */
export function ident(name: string): string {
    if (KEYWORDS.has(name) || !/^[A-Za-z_][A-Za-z0-9_']*$/.test(name)) return "``" + name + "``";
    return name;
}

export function pascal(name: string): string {
    const cleaned = name.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ""));
    if (cleaned.length === 0) return "Value";
    const head = cleaned[0].toUpperCase() + cleaned.slice(1);
    return /^[0-9]/.test(head) ? "N" + head : head;
}

export function str(s: string): string {
    return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/** Wrap a type in parentheses when it would otherwise bind wrongly as an element or argument. */
export function atom(t: string): string {
    if (/^[A-Za-z0-9_.`']+(<.*>)?(\[\])*$/.test(t) && !t.includes(" ")) return t;
    if (t.startsWith("(") && balancedOuter(t)) return t;
    return "(" + t + ")";
}

function balancedOuter(t: string): boolean {
    let depth = 0;
    for (let i = 0; i < t.length; i++) {
        if (t[i] === "(") depth++;
        else if (t[i] === ")") {
            depth--;
            if (depth === 0 && i !== t.length - 1) return false;
        }
    }
    return true;
}

function xml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export type Doc = {
    summary?: string;
    params?: Map<string, string>;
    returns?: string;
    deprecated?: string;
    defaultValue?: string;
    see?: string[];
};

/** XML doc lines for a declaration, indented by `indent`. */
export function docLines(doc: Doc | undefined, indent: string): string[] {
    if (!doc) return [];
    const out: string[] = [];
    const emit = (tag: string, text: string, attr = "") => {
        const lines = xml(text).split("\n").map((l) => l.trimEnd());
        while (lines.length && lines[lines.length - 1] === "") lines.pop();
        if (lines.length === 0) return;
        if (lines.length === 1) out.push(`${indent}/// <${tag}${attr}>${lines[0]}</${tag}>`);
        else {
            out.push(`${indent}/// <${tag}${attr}>`);
            for (const l of lines) out.push(`${indent}/// ${l}`.trimEnd());
            out.push(`${indent}/// </${tag}>`);
        }
    };
    let summary = doc.summary?.trim() ?? "";
    if (doc.defaultValue) summary += (summary ? "\n" : "") + `Default: ${doc.defaultValue}`;
    if (summary) emit("summary", summary);
    for (const [name, text] of doc.params ?? []) if (text.trim()) emit("param", text.trim(), ` name="${name}"`);
    if (doc.returns?.trim()) emit("returns", doc.returns.trim());
    return out;
}
