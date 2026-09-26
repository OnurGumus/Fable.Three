// Generates the Fable bindings in src/Fable.Three from @types/three.
//
//   npm run generate
//
// Reads every export of `three` and of `three/addons` through the TypeScript checker and
// writes one `namespace rec` file per entry point. The shape of the output — classes for
// JS classes, POJO classes with a named-argument constructor for option bags, enums for
// the numeric constants, erased unions with implicit conversions — is explained in
// docs/DESIGN.md; the reasoning behind each rule lives next to the rule below.

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { keepGenerics, memberOverrides, opaque, root, skip, type Target, targets, typeOverrides, typesDir } from "./config.ts";
import { atom, type Doc, docLines, ident, pascal, str } from "./fsharp.ts";

const SK = ts.SyntaxKind;
const browserTypes = new Set<string>(
    JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "browser-types.json"), "utf8")),
);

const program = ts.createProgram(
    targets.map((t) => t.entry),
    {
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        lib: ["lib.esnext.d.ts", "lib.dom.d.ts"],
        types: [],
        skipLibCheck: true,
        strict: true,
        noEmit: true,
    },
);
const checker = program.getTypeChecker();

// ---------------------------------------------------------------------------------------
// Registry

type Kind =
    | "class" // a JS class: imported when exported as a value, `[<Global>]` when type-only
    | "pojo" // an interface/type literal of properties: a class with a ParamObject constructor
    | "interface" // an interface with methods: `[<Interface>]`, implementable by object expressions
    | "enum" // numeric constants or a TS enum
    | "stringenum" // string constants or string literals
    | "union" // a named union of unlike types: an erased union with implicit conversions
    | "abbrev" // any other alias: an F# type abbreviation
    | "statics" // an object of functions exported as a value (MathUtils): static members
    | "value" // an exported constant
    | "function"; // an exported function

type Entry = {
    fsName: string;
    kind: Kind;
    symbol: ts.Symbol;
    target: Target;
    /** Name the JS module exports it under, when it is importable. */
    exportName?: string;
    /** Import `*` from the module (a namespace re-export such as BufferGeometryUtils). */
    namespaceImport?: boolean;
    module: string;
    file: string;
    /** Members for synthesized POJOs (anonymous object types lifted to a name). */
    literal?: { members: readonly ts.TypeElement[]; ctx: Ctx };
    /** Enum cases, resolved once. */
    cases?: { name: string; value: number | string }[];
};

const entries: Entry[] = [];
const bySymbol = new Map<ts.Symbol, Entry>();
const namesInNs = new Map<string, Set<string>>();
const constToEnum = new Map<ts.Symbol, Entry>();
const pending: Entry[] = [];
const report: string[] = [];

function nsNames(t: Target) {
    let s = namesInNs.get(t.ns);
    if (!s) namesInNs.set(t.ns, (s = new Set()));
    return s;
}

function freeName(t: Target, wanted: string, file?: string): string {
    const names = nsNames(t);
    let name = wanted;
    if (names.has(name) && file) name = pascal(path.basename(file).replace(/\.d\.ts$/, "")) + wanted;
    let i = 2;
    const base = name;
    while (names.has(name)) name = base + i++;
    names.add(name);
    return name;
}

function resolveAlias(s: ts.Symbol): ts.Symbol {
    return s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
}

function isTypeOnlyExport(s: ts.Symbol): boolean {
    let cur: ts.Symbol | undefined = s;
    for (let i = 0; cur && cur.flags & ts.SymbolFlags.Alias && i < 20; i++) {
        for (const d of cur.declarations ?? []) {
            if (ts.isExportSpecifier(d) && (d.isTypeOnly || d.parent.parent.isTypeOnly)) return true;
            if (ts.isImportSpecifier(d) && (d.isTypeOnly || d.parent.parent.isTypeOnly)) return true;
        }
        cur = checker.getImmediateAliasedSymbol(cur);
    }
    return false;
}

function fileOf(s: ts.Symbol): string {
    return s.declarations?.[0]?.getSourceFile().fileName ?? "";
}

function inThree(file: string): boolean {
    return file.startsWith(typesDir);
}

function targetFor(file: string): Target {
    return file.includes("/examples/jsm/") ? targets[1] : targets[0];
}

function decls<T extends ts.Node>(s: ts.Symbol, guard: (n: ts.Node) => n is T): T[] {
    const out: T[] = [];
    for (const d of s.declarations ?? []) if (guard(d)) out.push(d);
    return out;
}

/** What a declaration becomes in F#. */
function classify(s: ts.Symbol): Kind | undefined {
    const ds = s.declarations ?? [];
    if (ds.some(ts.isClassDeclaration)) return "class";
    if (ds.some(ts.isEnumDeclaration)) return "enum";
    if (ds.some(ts.isModuleDeclaration) || ds.some(ts.isSourceFile)) return "statics";
    const variable = ds.find(ts.isVariableDeclaration);
    if (variable) {
        const tn = variable.type;
        if (tn && ts.isTypeLiteralNode(tn) && tn.members.some(isFunctionLike)) return "statics";
        // `export const ColorManagement: ColorManagement` next to `interface ColorManagement`.
        if (tn && ts.isTypeReferenceNode(tn) && ds.some(ts.isInterfaceDeclaration)) return "statics";
        return "value";
    }
    if (ds.some(ts.isFunctionDeclaration)) return "function";
    const iface = ds.find(ts.isInterfaceDeclaration);
    if (iface) return interfaceKind(s);
    const alias = ds.find(ts.isTypeAliasDeclaration);
    if (alias) return aliasKind(alias);
    return undefined;
}

function isFunctionLike(m: ts.TypeElement): boolean {
    if (ts.isMethodSignature(m)) return true;
    if (ts.isPropertySignature(m) && m.type) {
        if (ts.isFunctionTypeNode(m.type)) return true;
        if (ts.isTypeQueryNode(m.type)) {
            const sym = checker.getSymbolAtLocation(m.type.exprName);
            const r = sym && resolveAlias(sym);
            return !!r && (r.flags & ts.SymbolFlags.Function) !== 0;
        }
    }
    return false;
}

/** An interface is a POJO when it and every interface it extends carry only properties. */
function interfaceKind(s: ts.Symbol): "pojo" | "interface" {
    const seen = new Set<ts.Symbol>();
    const visit = (sym: ts.Symbol): boolean => {
        if (seen.has(sym)) return true;
        seen.add(sym);
        for (const d of decls(sym, ts.isInterfaceDeclaration)) {
            for (const m of d.members) {
                if (ts.isMethodSignature(m) || ts.isCallSignatureDeclaration(m) || ts.isConstructSignatureDeclaration(m))
                    return false;
            }
            for (const h of d.heritageClauses ?? [])
                for (const t of h.types) {
                    const b = checker.getSymbolAtLocation(t.expression);
                    const rb = b && resolveAlias(b);
                    if (rb && rb.declarations?.some(ts.isInterfaceDeclaration) && !visit(rb)) return false;
                }
        }
        return true;
    };
    return visit(s) ? "pojo" : "interface";
}

function aliasKind(a: ts.TypeAliasDeclaration): Kind {
    const t = unparen(a.type);
    if (ts.isUnionTypeNode(t)) {
        const parts = flattenUnion(t.types).filter((p) => !isNullish(p));
        if (parts.length > 0 && parts.every((p) => constLiteral(p) !== undefined)) {
            const values = parts.map((p) => constLiteral(p)!.value);
            if (values.every((v) => typeof v === "number")) return "enum";
            if (values.every((v) => typeof v === "string")) return "stringenum";
        }
        if (parts.length > 1 && parts.every((p) => ts.isLiteralTypeNode(p) && ts.isStringLiteral(p.literal)))
            return "stringenum";
        return "union";
    }
    if (ts.isTypeLiteralNode(t) && t.members.length > 0 && !t.members.every(ts.isIndexSignatureDeclaration)
        && !t.members.every(ts.isCallSignatureDeclaration))
        return "pojo";
    return "abbrev";
}

function unparen(t: ts.TypeNode): ts.TypeNode {
    while (ts.isParenthesizedTypeNode(t)) t = t.type;
    return t;
}

function flattenUnion(types: readonly ts.TypeNode[]): ts.TypeNode[] {
    const out: ts.TypeNode[] = [];
    for (const t of types) {
        const u = unparen(t);
        if (ts.isUnionTypeNode(u)) out.push(...flattenUnion(u.types));
        else out.push(u);
    }
    return out;
}

function isNullish(t: ts.TypeNode): boolean {
    return (
        t.kind === SK.UndefinedKeyword ||
        t.kind === SK.VoidKeyword ||
        t.kind === SK.NullKeyword ||
        (ts.isLiteralTypeNode(t) && t.literal.kind === SK.NullKeyword)
    );
}

/** `typeof FrontSide` (a const with a literal type) or a bare string/number literal. */
function constLiteral(t: ts.TypeNode): { name?: string; value: number | string; symbol?: ts.Symbol } | undefined {
    if (ts.isTypeQueryNode(t)) {
        const sym = checker.getSymbolAtLocation(t.exprName);
        const r = sym && resolveAlias(sym);
        const v = r?.declarations?.find(ts.isVariableDeclaration);
        if (!r || !v || !v.type || !ts.isLiteralTypeNode(v.type)) return undefined;
        const lit = v.type.literal;
        if (ts.isNumericLiteral(lit)) return { name: r.name, value: Number(lit.text), symbol: r };
        if (ts.isPrefixUnaryExpression(lit) && ts.isNumericLiteral(lit.operand))
            return { name: r.name, value: -Number(lit.operand.text), symbol: r };
        if (ts.isStringLiteral(lit)) return { name: r.name, value: lit.text, symbol: r };
        return undefined;
    }
    return undefined;
}

/** A symbol's own name; `export default class NodeFrame` has the symbol name `default`. */
function declName(s: ts.Symbol): string {
    if (s.name !== "default") return s.name;
    const d = s.declarations?.[0] as { name?: ts.Node } | undefined;
    return d?.name && ts.isIdentifier(d.name) ? d.name.text : pascal(path.basename(fileOf(s)).replace(/\.d\.ts$/, ""));
}

/** The entry for a three declaration, binding it on first use unless its path is opaque. */
function lookup(s: ts.Symbol): Entry | undefined {
    const known = bySymbol.get(s);
    if (known) return known;
    const file = fileOf(s);
    if (!inThree(file) || opaque.some((r) => r.test(file))) return undefined;
    return register(s, targetFor(file), undefined, true);
}

function register(s: ts.Symbol, target: Target, exportName: string | undefined, typeOnly: boolean): Entry | undefined {
    const existing = bySymbol.get(s);
    if (existing) return existing;
    if (skip.has(s.name)) return undefined;
    const kind = classify(s);
    if (!kind) return undefined;
    const file = fileOf(s);
    const isValueExport = exportName !== undefined && !typeOnly;
    if ((kind === "value" || kind === "function" || kind === "statics") && !isValueExport && kind !== "statics") return undefined;
    const fsName = freeName(target, exportName && exportName !== "default" ? exportName : declName(s), file);
    const e: Entry = {
        fsName,
        kind,
        symbol: s,
        target,
        exportName: isValueExport ? exportName : undefined,
        namespaceImport: kind === "statics" && (s.flags & ts.SymbolFlags.ValueModule) !== 0,
        module: target.moduleOf(file),
        file,
    };
    entries.push(e);
    bySymbol.set(s, e);
    pending.push(e);
    return e;
}

function collect() {
    for (const target of targets) {
        const sf = program.getSourceFile(target.entry);
        if (!sf) throw new Error("missing entry " + target.entry);
        const mod = checker.getSymbolAtLocation(sf)!;
        for (const ex of checker.getExportsOfModule(mod)) {
            const resolved = resolveAlias(ex);
            if (!inThree(fileOf(resolved)) && !(resolved.flags & ts.SymbolFlags.ValueModule)) continue;
            // `export * from` in Addons.d.ts re-exports a module's members under their own names;
            // those come through here with their home file, which picks the import path.
            const t = targetFor(fileOf(resolved));
            if (t !== target && target === targets[0]) continue;
            register(resolved, target, ex.name, isTypeOnlyExport(ex));
        }
    }
    // Map the constants behind enum aliases to their enum.
    for (const e of [...entries]) {
        if (e.kind !== "enum" && e.kind !== "stringenum") continue;
        const alias = e.symbol.declarations?.find(ts.isTypeAliasDeclaration);
        if (!alias) continue;
        for (const p of flattenUnion([alias.type])) {
            const c = constLiteral(p);
            if (c?.symbol && !constToEnum.has(c.symbol)) constToEnum.set(c.symbol, e);
        }
    }
}

// ---------------------------------------------------------------------------------------
// Type mapping

type Pos = "param" | "return" | "prop" | "other";

type Ctx = {
    target: Target;
    thisType: string;
    tparams: Map<string, string>;
    owner: string;
    member?: string;
    pos: Pos;
};

/**
 * Types F# will not let hold null, which become `option` where TS allows null/undefined.
 * Erased unions are left alone: wrapping one in an option would block its implicit
 * conversions (`scene.background <- Color(...)`), and JS reads a missing one as null anyway.
 */
function isValueType(fs: string): boolean {
    if (/^(float|int|bool)$/.test(fs)) return true;
    if (fs.startsWith("(") && (fs.includes("->") || fs.includes(" * "))) return true;
    const e = entries.find((x) => x.fsName === fs);
    return !!e && (e.kind === "enum" || e.kind === "stringenum");
}

const TYPED_ARRAYS = new Set([
    "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
    "Float32Array", "Float64Array",
]);

function mapType(node: ts.TypeNode | undefined, ctx: Ctx): string {
    if (!node) return "obj";
    switch (node.kind) {
        case SK.NumberKeyword:
            return "float";
        case SK.StringKeyword:
        case SK.TemplateLiteralType:
            return "string";
        case SK.BooleanKeyword:
            return "bool";
        case SK.VoidKeyword:
        case SK.UndefinedKeyword:
            return "unit";
        case SK.AnyKeyword:
        case SK.UnknownKeyword:
        case SK.ObjectKeyword:
        case SK.NeverKeyword:
        case SK.SymbolKeyword:
        case SK.BigIntKeyword:
        case SK.NullKeyword:
            return "obj";
        case SK.ThisType:
            return ctx.thisType;
        case SK.TypePredicate:
            return "bool";
    }
    if (ts.isLiteralTypeNode(node)) {
        const l = node.literal;
        if (ts.isStringLiteral(l)) return "string";
        if (ts.isNumericLiteral(l) || ts.isPrefixUnaryExpression(l)) return "float";
        if (l.kind === SK.TrueKeyword || l.kind === SK.FalseKeyword) return "bool";
        return "obj";
    }
    if (ts.isParenthesizedTypeNode(node)) return mapType(node.type, ctx);
    if (ts.isArrayTypeNode(node)) return atom(mapType(node.elementType, { ...ctx, pos: "other" })) + "[]";
    if (ts.isTupleTypeNode(node)) {
        const els = node.elements.map((e) => (ts.isNamedTupleMember(e) ? e : e));
        if (els.length === 0 || els.some((e) => ts.isRestTypeNode(e) || ts.isOptionalTypeNode(e) || (ts.isNamedTupleMember(e) && (e.dotDotDotToken || e.questionToken))))
            return "obj[]";
        const parts = els.map((e) => atom(mapType(ts.isNamedTupleMember(e) ? e.type : e, { ...ctx, pos: "other" })));
        // Fable compiles an F# tuple to a JS array, so `[number, number, number]` is
        // `float * float * float`; past four elements (Matrix4's sixteen) an array reads better.
        if (parts.length === 1 || (parts.length > 4 && parts.every((p) => p === parts[0]))) return parts[0] + "[]";
        return "(" + parts.join(" * ") + ")";
    }
    if (ts.isTypeOperatorNode(node)) {
        if (node.operator === SK.KeyOfKeyword) return "string";
        if (node.operator === SK.ReadonlyKeyword) return mapType(node.type, ctx);
        return "obj";
    }
    if (ts.isUnionTypeNode(node)) return mapUnion(node.types, ctx);
    if (ts.isIntersectionTypeNode(node)) {
        const mapped = node.types.map((t) => mapType(t, ctx)).filter((t) => t !== "obj");
        return mapped[0] ?? "obj";
    }
    if (ts.isFunctionTypeNode(node)) return mapFunction(node.parameters, node.type, ctx);
    if (ts.isTypeLiteralNode(node)) return mapTypeLiteral(node, ctx);
    if (ts.isTypeQueryNode(node)) {
        const sym = checker.getSymbolAtLocation(node.exprName);
        const r = sym && resolveAlias(sym);
        if (r) {
            const en = constToEnum.get(r);
            if (en) return ref(en, ctx);
            const c = constLiteral(node);
            if (c) return typeof c.value === "number" ? "float" : "string";
            const v = r.declarations?.find(ts.isVariableDeclaration);
            if (v?.type) return mapType(v.type, ctx);
            const f = r.declarations?.find(ts.isFunctionDeclaration);
            if (f) return mapFunction(f.parameters, f.type, ctx);
        }
        return "obj";
    }
    if (ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node)) return mapTypeRef(node, ctx);
    if (ts.isImportTypeNode(node) && node.qualifier) {
        const t = checker.getTypeFromTypeNode(node);
        const s = t.aliasSymbol ?? t.getSymbol();
        if (s) return mapSymbolRef(resolveAlias(s), [], ctx, node.qualifier.getText());
    }
    return "obj";
}

function mapUnion(types: readonly ts.TypeNode[], ctx: Ctx): string {
    const all = flattenUnion(types);
    const nullable = all.some(isNullish);
    const parts = all.filter((t) => !isNullish(t));
    if (parts.length === 0) return "obj";
    const stringy = (t: ts.TypeNode) =>
        t.kind === SK.StringKeyword || t.kind === SK.TemplateLiteralType || (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal));
    const numeric = (t: ts.TypeNode) =>
        t.kind === SK.NumberKeyword || (ts.isLiteralTypeNode(t) && (ts.isNumericLiteral(t.literal) || ts.isPrefixUnaryExpression(t.literal)));
    const boolish = (t: ts.TypeNode) =>
        t.kind === SK.BooleanKeyword || (ts.isLiteralTypeNode(t) && (t.literal.kind === SK.TrueKeyword || t.literal.kind === SK.FalseKeyword));
    let single: string | undefined;
    if (parts.every(stringy)) single = "string";
    else if (parts.every(numeric)) single = "float";
    else if (parts.every(boolish)) single = "bool";
    else {
        // All constants of one enum (an anonymous subset such as `typeof A | typeof B`).
        const enums = parts.map((p) => {
            const c = constLiteral(p);
            return c?.symbol ? constToEnum.get(c.symbol) : undefined;
        });
        if (enums.every((e) => e && e === enums[0])) single = ref(enums[0]!, ctx);
    }
    if (single) return nullable && ctx.pos !== "param" && isValueType(single) ? `${atom(single)} option` : single;

    const inner = { ...ctx, pos: "other" as Pos };
    // `HTMLElement | SVGElement`: keep what F# can name rather than giving up on the union.
    const known = parts.filter((p) => !isUnboundLibRef(p) && !isOpaqueRef(p));
    let mapped = collapseTypedArrays(unique((known.length > 0 ? known : parts).map((p) => mapType(p, inner))));
    // `string | "Mesh"` style: a literal alongside its base type adds nothing.
    if (mapped.includes("obj")) return "obj";
    mapped = mapped.filter((m) => m !== "unit");
    if (mapped.length === 0) return "obj";
    if (mapped.length === 1) {
        const t = mapped[0];
        return nullable && ctx.pos !== "param" && isValueType(t) ? `${atom(t)} option` : t;
    }
    if (mapped.length > 8) return "obj";
    return `Union<${mapped.join(", ")}>`;
}

/**
 * How many times mapping fell back to `obj` because a type lives in an opaque subsystem
 * (the WebGPU node system). Read around a member's mapping to tell a member that only
 * exists for WebGPU from one that is merely untyped.
 */
let opaqueHits = 0;

/** A type that says nothing but `obj`: `obj`, `obj[]`, `obj option`, `(unit -> obj) option`. */
function isObjish(t: string): boolean {
    return t.includes("obj") && t.replace(/\bobj\b|\bunit\b|\boption\b|->|\[\]|[()*\s]/g, "") === "";
}

/** A reference to a three type in an opaque subsystem that is not bound (a node). */
function isOpaqueRef(t: ts.TypeNode): boolean {
    if (!ts.isTypeReferenceNode(t)) return false;
    const s0 = checker.getSymbolAtLocation(t.typeName);
    const s = s0 && resolveAlias(s0);
    if (!s || bySymbol.has(s)) return false;
    const file = fileOf(s);
    return inThree(file) && opaque.some((r) => r.test(file));
}

/** A reference to a DOM/lib type with no Fable.Browser binding (SVGElement, XRFrame...). */
function isUnboundLibRef(t: ts.TypeNode): boolean {
    if (!ts.isTypeReferenceNode(t)) return false;
    const s0 = checker.getSymbolAtLocation(t.typeName);
    const s = s0 && resolveAlias(s0);
    if (!s || inThree(fileOf(s))) return false;
    const name = t.typeName.getText().split(".").pop()!;
    return !browserTypes.has(name) && !TYPED_ARRAYS.has(name) && !LIB_TYPES.has(name);
}

const LIB_TYPES = new Set(["Array", "ReadonlyArray", "ArrayLike", "Iterable", "IterableIterator", "Promise", "PromiseLike", "Record", "Partial", "Readonly", "Required", "NonNullable", "Omit", "Pick", "Exclude", "Extract", "Map", "Set", "ArrayBuffer", "ArrayBufferLike", "SharedArrayBuffer", "ArrayBufferView", "DataView", "Date", "Error", "TypedArray"]);

function unique<T>(xs: T[]): T[] {
    return [...new Set(xs)];
}

/**
 * Two or more typed arrays in a union collapse to `JS.TypedArray`: F# sees `JS.Uint8Array`
 * and `JS.Uint8ClampedArray` as the same type, so they cannot be separate union cases.
 */
function collapseTypedArrays(ts_: string[]): string[] {
    const typed = ts_.filter((t) => /^JS\.(Int|Uint|Float)\w*Array$/.test(t) || t === "JS.TypedArray");
    if (typed.length < 2) return ts_;
    const out: string[] = [];
    for (const t of ts_) {
        const v = typed.includes(t) ? "JS.TypedArray" : t;
        if (!out.includes(v)) out.push(v);
    }
    return out;
}

function mapFunction(params: readonly ts.ParameterDeclaration[], ret: ts.TypeNode | undefined, ctx: Ctx): string {
    const inner = { ...ctx, pos: "other" as Pos };
    // Trailing optional parameters are dropped: JS passes them regardless, and F# callers
    // would otherwise have to accept arguments they never use (`fun time _frame -> ...`).
    const ps = [...params];
    while (ps.length > 0 && (ps[ps.length - 1].questionToken || ps[ps.length - 1].initializer)) ps.pop();
    if (ps.some((p) => p.dotDotDotToken)) return "obj";
    const ps2 = ps.filter((p) => !(ts.isIdentifier(p.name) && p.name.text === "this"));
    const args = ps2.length === 0 ? ["unit"] : ps2.map((p) => atomFn(mapType(p.type, inner)));
    // A callback declared to return `any` has its result ignored; `unit` lets F# lambdas
    // written as statements (`fun o -> o.visible <- false`) type-check.
    const r = !ret || ret.kind === SK.AnyKeyword || ret.kind === SK.UnknownKeyword ? "unit" : mapType(ret, inner);
    return "(" + [...args, atomFn(r)].join(" -> ") + ")";
}

function atomFn(t: string): string {
    return t.includes("->") && !(t.startsWith("(") && t.endsWith(")")) ? "(" + t + ")" : t.includes(" * ") && !t.startsWith("(") ? "(" + t + ")" : t;
}

function mapTypeLiteral(node: ts.TypeLiteralNode, ctx: Ctx): string {
    const ms = node.members;
    if (ms.length === 0) return "obj";
    if (ms.every(ts.isIndexSignatureDeclaration)) {
        const v = mapType(ms[0].type, { ...ctx, pos: "other" });
        return `Record<${v}>`;
    }
    if (ms.every(ts.isCallSignatureDeclaration)) {
        const c = ms[0];
        return mapFunction(c.parameters, c.type, ctx);
    }
    return synthesize(node, ctx);
}

const synthesized = new Map<ts.Node, Entry>();

function synthesize(node: ts.TypeLiteralNode, ctx: Ctx): string {
    const known = synthesized.get(node);
    if (known) return ref(known, ctx);
    const base = pascal(ctx.owner) + pascal(ctx.member ?? "Options");
    const fsName = freeName(ctx.target, base);
    const methods = node.members.some((m) => ts.isMethodSignature(m) || ts.isCallSignatureDeclaration(m));
    const e: Entry = {
        fsName,
        kind: methods ? "interface" : "pojo",
        symbol: undefined as unknown as ts.Symbol,
        target: ctx.target,
        module: "",
        file: node.getSourceFile().fileName,
        literal: { members: node.members, ctx: { ...ctx, owner: fsName, member: undefined } },
    };
    entries.push(e);
    synthesized.set(node, e);
    pending.push(e);
    return ref(e, ctx);
}

/** The F# name of an entry as seen from `ctx`'s namespace. */
function ref(e: Entry, ctx: Ctx): string {
    if (e.target.ns === ctx.target.ns) return e.fsName;
    // Addons see core names through `open Three`, unless an addon declares the same name.
    return nsNames(ctx.target).has(e.fsName) ? `${e.target.ns}.${e.fsName}` : e.fsName;
}

function entityText(n: ts.EntityName | ts.Expression): string {
    return n.getText();
}

function mapTypeRef(node: ts.TypeReferenceNode | ts.ExpressionWithTypeArguments, ctx: Ctx): string {
    const nameNode = ts.isTypeReferenceNode(node) ? node.typeName : node.expression;
    const full = entityText(nameNode);
    const simple = full.split(".").pop()!;
    const args = node.typeArguments ?? [];
    if (typeOverrides[simple]) return typeOverrides[simple];
    if (ctx.tparams.has(full)) return ctx.tparams.get(full)!;
    const sym0 = checker.getSymbolAtLocation(nameNode);
    const sym = sym0 && resolveAlias(sym0);
    if (sym && sym.flags & ts.SymbolFlags.TypeParameter) return ctx.tparams.get(sym.name) ?? "obj";
    return mapSymbolRef(sym, args, ctx, simple);
}

function mapSymbolRef(sym: ts.Symbol | undefined, args: readonly ts.TypeNode[], ctx: Ctx, simple: string): string {
    const inner = { ...ctx, pos: "other" as Pos };
    const arg = (i: number) => mapType(args[i], inner);
    const file = sym ? fileOf(sym) : "";
    const fromLib = !sym || file.includes("/typescript/lib/");
    if (fromLib || !inThree(file)) {
        switch (simple) {
            case "Array":
            case "ReadonlyArray":
            case "ArrayLike":
                return atom(arg(0)) + "[]";
            case "Iterable":
            case "IterableIterator":
                return `seq<${arg(0)}>`;
            case "Promise":
            case "PromiseLike":
                return `JS.Promise<${arg(0)}>`;
            case "Record":
                return `Record<${arg(1)}>`;
            case "Partial":
            case "Readonly":
            case "Required":
            case "NonNullable":
            case "Omit":
            case "Pick":
            case "Exclude":
            case "Extract":
                return args.length ? mapType(args[0], ctx) : "obj";
            case "Map":
                return `JS.Map<${arg(0)}, ${arg(1)}>`;
            case "Set":
                return `JS.Set<${arg(0)}>`;
            case "ArrayBuffer":
            case "ArrayBufferLike":
            case "SharedArrayBuffer":
                return "JS.ArrayBuffer";
            case "ArrayBufferView":
                return "JS.ArrayBufferView";
            case "DataView":
                return "JS.DataView";
            case "Date":
                return "JS.Date";
            case "Error":
                return "exn";
            case "BigInt64Array":
            case "BigUint64Array":
                return "obj";
        }
        if (TYPED_ARRAYS.has(simple)) return `JS.${simple}`;
        if (simple === "TypedArray") return "JS.TypedArray";
        if (browserTypes.has(simple)) return `Browser.Types.${simple}`;
        return "obj";
    }
    if (!sym) return "obj";
    // A three declaration.
    let e = bySymbol.get(sym);
    if (!e) {
        if (skip.has(sym.name)) return typeOverrides[sym.name] ?? "obj";
        // Not exported under this entry: bind it anyway so the signature can name it, unless
        // it belongs to a subsystem this package does not cover.
        if (opaque.some((r) => r.test(file))) {
            opaqueHits++;
            return "obj";
        }
        const t = targetFor(file);
        e = register(sym, t, undefined, true);
        if (!e) {
            // A type alias to something simple we can inline, or an unbindable declaration.
            const alias = sym.declarations?.find(ts.isTypeAliasDeclaration);
            if (alias) return mapType(alias.type, withTypeArgs(alias.typeParameters, args, ctx));
            return "obj";
        }
    }
    if (e.kind === "value" || e.kind === "function") return "obj";
    // `XLike` interfaces stand for a class of the same shape; F# is nominal, so take the class.
    if (e.kind !== "class" && /Like$/.test(e.fsName)) {
        const cls = entries.find((x) => x.kind === "class" && x.fsName === e!.fsName.replace(/Like$/, "") && x.target === e!.target);
        if (cls) return ref(cls, ctx);
    }
    const kept = keptParams(e);
    if (kept.length > 0) {
        const tps = typeParamsOf(e);
        const mappedArgs = kept.map((k) => {
            const i = tps.findIndex((tp) => tp.name.text === k);
            const a = args[i] ?? tps[i]?.default ?? tps[i]?.constraint;
            return a ? mapType(a, inner) : "obj";
        });
        return `${ref(e, ctx)}<${mappedArgs.join(", ")}>`;
    }
    return ref(e, ctx);
}

function withTypeArgs(tps: readonly ts.TypeParameterDeclaration[] | undefined, args: readonly ts.TypeNode[], ctx: Ctx): Ctx {
    if (!tps || tps.length === 0) return ctx;
    const m = new Map(ctx.tparams);
    tps.forEach((tp, i) => {
        const a = args[i] ?? tp.default ?? tp.constraint;
        m.set(tp.name.text, a ? mapType(a, { ...ctx, tparams: m, pos: "other" }) : "obj");
    });
    return { ...ctx, tparams: m };
}

function typeParamsOf(e: Entry): readonly ts.TypeParameterDeclaration[] {
    const d = e.symbol?.declarations?.find((x) => ts.isClassDeclaration(x) || ts.isInterfaceDeclaration(x)) as
        | ts.ClassDeclaration
        | ts.InterfaceDeclaration
        | undefined;
    return d?.typeParameters ?? [];
}

function keptParams(e: Entry): string[] {
    if (!e.symbol || e.kind !== "class") return [];
    return keepGenerics[e.fsName] ?? [];
}

/** The erased mapping for each type parameter of a declaration. */
function typeParamCtx(e: Entry, ctx: Ctx): Ctx {
    const tps = typeParamsOf(e);
    const kept = keptParams(e);
    const m = new Map(ctx.tparams);
    for (const tp of tps) {
        const n = tp.name.text;
        if (kept.includes(n)) {
            m.set(n, "'" + n);
            continue;
        }
        m.set(n, "obj"); // guards self-reference while mapping the constraint
        const c = tp.constraint ?? tp.default;
        m.set(n, c ? eraseParam(c, { ...ctx, tparams: m, pos: "other" }) : "obj");
    }
    return { ...ctx, tparams: m };
}

/** A class type parameter's erased form. `Material | Material[]` becomes Material. */
function eraseParam(c: ts.TypeNode, ctx: Ctx): string {
    const u = unparen(c);
    if (ts.isUnionTypeNode(u)) {
        const parts = flattenUnion(u.types).filter((p) => !isNullish(p));
        const mapped = unique(parts.map((p) => mapType(p, ctx)));
        const scalar = mapped.filter((m) => !m.endsWith("[]"));
        if (scalar.length === 1 && mapped.every((m) => m === scalar[0] || m === scalar[0] + "[]")) return scalar[0];
    }
    const t = mapType(c, ctx);
    return t === "unit" ? "obj" : t;
}

// ---------------------------------------------------------------------------------------
// Documentation

function docOf(node: ts.Node | undefined): Doc | undefined {
    if (!node) return undefined;
    const jsDocs = (node as unknown as { jsDoc?: ts.JSDoc[] }).jsDoc;
    if (!jsDocs || jsDocs.length === 0) return undefined;
    const d = jsDocs[jsDocs.length - 1];
    const doc: Doc = { params: new Map() };
    doc.summary = cleanDoc(ts.getTextOfJSDocComment(d.comment));
    for (const tag of d.tags ?? []) {
        const text = cleanDoc(ts.getTextOfJSDocComment(tag.comment));
        const name = tag.tagName.text;
        if (ts.isJSDocParameterTag(tag)) doc.params!.set(tag.name.getText(), text.replace(/^-\s*/, ""));
        else if (name === "returns" || name === "return") doc.returns = text;
        else if (name === "deprecated") doc.deprecated = text || "Deprecated.";
        else if (name === "default" || name === "defaultValue") doc.defaultValue = text.replace(/^`|`$/g, "");
    }
    return doc;
}

function cleanDoc(s: string | undefined): string {
    if (!s) return "";
    return s
        .replace(/\{@link(?:code|plain)?\s+([^}|\s]+)(?:[\s|]+([^}]*))?\}/g, (_, target: string, text?: string) => (text?.trim() ? text.trim() : target.replace(/^.*[#.](?=[^#.]+$)/, (m) => m)))
        .replace(/\r/g, "")
        .trim();
}

function obsolete(doc: Doc | undefined, indent: string): string[] {
    return doc?.deprecated ? [`${indent}[<System.Obsolete(${str(doc.deprecated.split("\n")[0])})>]`] : [];
}

// ---------------------------------------------------------------------------------------
// Signatures

type Param = {
    name: string;
    type: string;
    optional: boolean;
    rest: boolean;
    unionParts?: string[];
    /** `...args: [color: ColorRepresentation] | [r: number, g: number, b: number]` spelled out. */
    tupleVariants?: Param[][];
};

function isPrivate(m: ts.Node): boolean {
    const mods = ts.canHaveModifiers(m) ? ts.getModifiers(m) : undefined;
    if (mods?.some((x) => x.kind === SK.PrivateKeyword || x.kind === SK.ProtectedKeyword)) return true;
    const n = (m as { name?: ts.Node }).name;
    return !!n && (ts.isPrivateIdentifier(n) || ts.isComputedPropertyName(n));
}

function isPrivateOnly(m: ts.Node): boolean {
    const mods = ts.canHaveModifiers(m) ? ts.getModifiers(m) : undefined;
    return !!mods?.some((x) => x.kind === SK.PrivateKeyword);
}

function isStatic(m: ts.Node): boolean {
    const mods = ts.canHaveModifiers(m) ? ts.getModifiers(m) : undefined;
    return !!mods?.some((x) => x.kind === SK.StaticKeyword);
}

function isReadonly(m: ts.Node): boolean {
    const mods = ts.canHaveModifiers(m) ? ts.getModifiers(m) : undefined;
    return !!mods?.some((x) => x.kind === SK.ReadonlyKeyword);
}

function memberName(n: ts.PropertyName): string | undefined {
    if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n)) return n.text;
    return undefined;
}

function methodCtx(ctx: Ctx, tps: readonly ts.TypeParameterDeclaration[] | undefined, member: string): Ctx {
    const m = new Map(ctx.tparams);
    for (const tp of tps ?? []) {
        m.set(tp.name.text, "obj");
        const c = tp.constraint;
        if (c) m.set(tp.name.text, eraseParam(c, { ...ctx, tparams: m, pos: "other" }));
    }
    return { ...ctx, tparams: m, member };
}

function params(ps: readonly ts.ParameterDeclaration[], ctx: Ctx): Param[] {
    const out: Param[] = [];
    for (const p of ps) {
        if (ts.isIdentifier(p.name) && p.name.text === "this") continue;
        const name = ts.isIdentifier(p.name) ? p.name.text : "arg" + out.length;
        // Loader callbacks are optional everywhere. `Loader.load` declares `onLoad` required
        // and `TextureLoader.load` optional; F# only lets the subclass's overload hide the
        // base's when the two signatures match exactly, otherwise every call is ambiguous.
        const optional = !!p.questionToken || !!p.initializer || /^on(Load|Progress|Error)$/.test(name);
        const rest = !!p.dotDotDotToken;
        const pctx = { ...ctx, pos: "param" as Pos, member: ctx.member ? ctx.member + pascal(name) : name };
        if (rest && p.type) {
            const tuples = restTuples(p.type);
            if (tuples) {
                out.push({ name, type: "obj[]", optional: false, rest: true, tupleVariants: tuples.map((t) => tupleParams(t, pctx)) });
                continue;
            }
        }
        let type = mapType(p.type, pctx);
        if (rest && !type.endsWith("[]")) type = "obj[]";
        const parts = unionPartsOf(p.type, pctx);
        out.push({ name, type, optional, rest, unionParts: parts });
    }
    // F# wants optional arguments last and a ParamArray after them all.
    let seenRequired = false;
    for (let i = out.length - 1; i >= 0; i--) {
        if (out[i].rest) continue;
        if (!out[i].optional) seenRequired = true;
        else if (seenRequired) out[i].optional = false;
    }
    const restIdx = out.findIndex((p) => p.rest);
    if (restIdx >= 0) for (let i = 0; i < restIdx; i++) out[i].optional = false;
    return out;
}

function restTuples(t: ts.TypeNode): ts.TupleTypeNode[] | undefined {
    const u = unparen(t);
    if (ts.isTupleTypeNode(u)) return [u];
    if (ts.isUnionTypeNode(u)) {
        const parts = flattenUnion(u.types);
        if (parts.every(ts.isTupleTypeNode)) return parts as ts.TupleTypeNode[];
    }
    return undefined;
}

function tupleParams(t: ts.TupleTypeNode, ctx: Ctx): Param[] {
    const out: Param[] = t.elements.map((el, i) => {
        const named = ts.isNamedTupleMember(el) ? el : undefined;
        const inner = named ? named.type : el;
        const optional = !!named?.questionToken || ts.isOptionalTypeNode(inner);
        const rest = !!named?.dotDotDotToken || ts.isRestTypeNode(inner);
        const tn = ts.isOptionalTypeNode(inner) ? inner.type : ts.isRestTypeNode(inner) ? inner.type : inner;
        let type = mapType(tn, { ...ctx, pos: "param" });
        if (rest && !type.endsWith("[]")) type = "obj[]";
        return { name: named ? named.name.text : "arg" + i, type, optional, rest, unionParts: unionPartsOf(tn, ctx) };
    });
    let seenRequired = false;
    for (let i = out.length - 1; i >= 0; i--) {
        if (out[i].rest) continue;
        if (!out[i].optional) seenRequired = true;
        else if (seenRequired) out[i].optional = false;
    }
    return out;
}

/** The members of a union parameter worth an overload each, when there are few enough. */
function unionPartsOf(t: ts.TypeNode | undefined, ctx: Ctx): string[] | undefined {
    if (!t) return undefined;
    const u = unparen(t);
    let parts: ts.TypeNode[] | undefined;
    if (ts.isUnionTypeNode(u)) parts = flattenUnion(u.types).filter((p) => !isNullish(p));
    else if (ts.isTypeReferenceNode(u) && ctx.tparams.has(u.typeName.getText())) {
        // An erased type parameter whose constraint is `X | X[]` (Mesh's material).
        const sym = checker.getSymbolAtLocation(u.typeName);
        const tp = sym?.declarations?.find(ts.isTypeParameterDeclaration);
        const c = tp?.constraint && unparen(tp.constraint);
        if (c && ts.isUnionTypeNode(c)) parts = flattenUnion(c.types).filter((p) => !isNullish(p));
    }
    if (!parts || parts.length < 2) return undefined;
    const inner = { ...ctx, pos: "other" as Pos };
    const mapped = collapseTypedArrays(unique(parts.map((p) => mapType(p, inner))));
    if (mapped.length < 2 || mapped.length > 4 || mapped.includes("obj")) return undefined;
    return mapped;
}

/**
 * One F# overload per member of a union parameter, so a subclass argument (a
 * MeshStandardMaterial where `Material | Material[]` is expected) needs no cast. Only the
 * first overload keeps earlier arguments optional; the others make everything up to the
 * union argument required, so `new Mesh()` still resolves to exactly one constructor.
 */
function expand(ps: Param[]): Param[][] {
    const t = ps.findIndex((p) => p.tupleVariants);
    if (t >= 0) {
        // Earlier arguments are required once a tuple variant follows them.
        const head = ps.slice(0, t).map((p) => ({ ...p, optional: false }));
        return ps[t].tupleVariants!.flatMap((v) => expand([...head, ...v]));
    }
    let variants: Param[][] = [ps.map((p) => ({ ...p }))];
    ps.forEach((p, idx) => {
        if (!p.unionParts || p.rest) return;
        const next: Param[][] = [];
        for (const v of variants)
            p.unionParts.forEach((part, k) =>
                next.push(
                    v.map((q, i) => {
                        const copy = { ...q };
                        if (i === idx) {
                            copy.type = part;
                            copy.unionParts = undefined;
                        }
                        if (k > 0 && i <= idx) copy.optional = false;
                        return copy;
                    }),
                ),
            );
        variants = next;
    });
    // Past a handful of overloads the erased unions read better than the list.
    if (variants.length > 8) return [ps.map((p) => ({ ...p, unionParts: undefined }))];
    return variants;
}

function paramList(ps: Param[]): string {
    return ps
        .map((p) => {
            const n = ident(p.name);
            if (p.rest) return `[<System.ParamArray>] ${n}: ${p.type}`;
            return p.optional ? `?${n}: ${p.type}` : `${n}: ${p.type}`;
        })
        .join(", ");
}

function sigKey(name: string, ps: Param[], isStaticMember: boolean): string {
    return (isStaticMember ? "static " : "") + name + "(" + ps.map((p) => (p.optional ? "?" : "") + p.type).join(",") + ")";
}

function propTypeCtx(ctx: Ctx, name: string): Ctx {
    return { ...ctx, pos: "prop", member: name };
}

// ---------------------------------------------------------------------------------------
// Emitters

type Out = string[];

function header(out: Out, doc: Doc | undefined) {
    out.push("");
    out.push(...docLines(doc, ""));
    out.push(...obsolete(doc, ""));
}

function importAttr(e: Entry): string {
    if (e.namespaceImport) return `[<Import("*", ${str(e.module)})>]`;
    return `[<Import(${str(e.exportName!)}, ${str(e.module)})>]`;
}

function emitEnum(e: Entry, out: Out) {
    const ts_ = e.symbol.declarations?.find(ts.isEnumDeclaration);
    const alias = e.symbol.declarations?.find(ts.isTypeAliasDeclaration);
    const cases: { name: string; value: number; doc?: Doc }[] = [];
    if (ts_) {
        let next = 0;
        for (const m of ts_.members) {
            const v = m.initializer && ts.isNumericLiteral(m.initializer) ? Number(m.initializer.text) : next;
            next = v + 1;
            cases.push({ name: m.name.getText(), value: v, doc: docOf(m) });
        }
    } else if (alias) {
        for (const p of flattenUnion([alias.type])) {
            const c = constLiteral(p);
            if (c && typeof c.value === "number") {
                const decl = c.symbol?.declarations?.[0];
                cases.push({ name: c.name!, value: c.value, doc: docOf(decl?.parent?.parent) ?? docOf(decl) });
            }
        }
    }
    header(out, docOf(ts_ ?? alias));
    out.push(`type ${e.fsName} =`);
    const seen = new Set<string>();
    for (const c of cases) {
        if (seen.has(c.name)) continue;
        seen.add(c.name);
        out.push(...docLines(c.doc, "    "));
        const obs = c.doc?.deprecated ? `[<System.Obsolete(${str(c.doc.deprecated.split("\n")[0])})>] ` : "";
        out.push(`    | ${obs}${ident(caseName(c.name))} = ${Math.trunc(c.value)}`);
    }
}

function caseName(n: string): string {
    return /^[A-Z]/.test(n) ? n : pascal(n);
}

function emitStringEnum(e: Entry, out: Out) {
    const alias = e.symbol.declarations?.find(ts.isTypeAliasDeclaration)!;
    const cases: { name: string; value: string }[] = [];
    for (const p of flattenUnion([alias.type])) {
        if (isNullish(p)) continue;
        const c = constLiteral(p);
        if (c && typeof c.value === "string") cases.push({ name: c.name!, value: c.value });
        else if (ts.isLiteralTypeNode(p) && ts.isStringLiteral(p.literal))
            cases.push({ name: p.literal.text === "" ? "None" : pascal(p.literal.text), value: p.literal.text });
    }
    header(out, docOf(alias));
    out.push("[<StringEnum; RequireQualifiedAccess>]");
    out.push(`type ${e.fsName} =`);
    const seen = new Set<string>();
    for (const c of cases) {
        let n = caseName(c.name);
        while (seen.has(n)) n += "_";
        seen.add(n);
        out.push(`    | [<CompiledName(${str(c.value)})>] ${ident(n)}`);
    }
}

function caseFor(t: string): string {
    const base = t
        .replace(/^Browser\.Types\.|^JS\./, "")
        .replace(/<.*>/, "")
        .replace(/\[\]/g, "Array")
        .replace(/ option$/, "Option");
    if (t.includes("->")) return "Function";
    if (t.includes(" * ")) return "Tuple";
    return pascal(base);
}

function emitUnion(e: Entry, out: Out) {
    const alias = e.symbol.declarations?.find(ts.isTypeAliasDeclaration)!;
    const ctx = typeParamCtxForAlias(e, alias);
    const parts = flattenUnion([alias.type]).filter((p) => !isNullish(p));
    const mapped = collapseTypedArrays(unique(parts.map((p) => mapType(p, { ...ctx, pos: "other" }))).filter((m) => m !== "unit"));
    if (mapped.includes("obj") || mapped.length < 2) {
        // Not worth a union: an abbreviation of whatever it collapsed to.
        header(out, docOf(alias));
        out.push(`type ${e.fsName} = ${mapped.length === 1 ? mapped[0] : "obj"}`);
        return;
    }
    header(out, docOf(alias));
    out.push("[<Erase; RequireQualifiedAccess>]");
    out.push(`type ${e.fsName} =`);
    const names: string[] = [];
    for (const m of mapped) {
        let n = caseFor(m);
        while (names.includes(n)) n += "_";
        names.push(n);
        out.push(`    | ${n} of ${m}`);
    }
    mapped.forEach((m, i) => {
        out.push(`    static member inline op_Implicit(x: ${m}) : ${e.fsName} = ${e.fsName}.${names[i]} x`);
    });
    if (mapped.includes("float") && !mapped.includes("int"))
        out.push(`    static member inline op_Implicit(x: int) : ${e.fsName} = ${e.fsName}.${names[mapped.indexOf("float")]} (float x)`);
    mapped.forEach((m, i) => {
        out.push(`    static member inline op_ErasedCast(x: ${m}) : ${e.fsName} = ${e.fsName}.${names[i]} x`);
    });
}

function typeParamCtxForAlias(e: Entry, alias: ts.TypeAliasDeclaration): Ctx {
    const ctx = baseCtx(e);
    const m = new Map<string, string>();
    for (const tp of alias.typeParameters ?? []) {
        m.set(tp.name.text, "obj");
        const c = tp.constraint ?? tp.default;
        if (c) m.set(tp.name.text, eraseParam(c, { ...ctx, tparams: m, pos: "other" }));
    }
    return { ...ctx, tparams: m };
}

function baseCtx(e: Entry): Ctx {
    return { target: e.target, thisType: e.fsName, tparams: new Map(), owner: e.fsName, pos: "other" };
}

function emitAbbrev(e: Entry, out: Out) {
    const alias = e.symbol.declarations?.find(ts.isTypeAliasDeclaration)!;
    const ctx = typeParamCtxForAlias(e, alias);
    let t = mapType(alias.type, { ...ctx, pos: "other" });
    if (t === e.fsName || t === "unit") t = "obj";
    header(out, docOf(alias));
    out.push(`type ${e.fsName} = ${t}`);
}

type PropSpec = { name: string; type: string; readonly: boolean; optional: boolean; doc?: Doc; isStatic: boolean };
type MethodSpec = { name: string; params: Param[]; ret: string; doc?: Doc; isStatic: boolean; typeParams: string[]; declaredIn?: string };

const HOOK = /^on[A-Z]/;

/**
 * Properties and methods of a member list. In a class, `onBeforeRender(...)` and the other
 * `on*` hooks become assignable function-typed properties (they exist to be replaced), and
 * a function-typed property that is not a hook (`compile: (scene, camera) => ...`, set up
 * in the JS constructor) becomes a method.
 */
function collectMembers(members: readonly (ts.TypeElement | ts.ClassElement)[], ctx: Ctx, inClass = false) {
    const props: PropSpec[] = [];
    const methods: MethodSpec[] = [];
    const indexers: string[] = [];
    const accessors = new Map<string, { get?: ts.GetAccessorDeclaration; set?: ts.SetAccessorDeclaration }>();
    for (const m of members) {
        if (isPrivate(m)) continue;
        if (ts.isIndexSignatureDeclaration(m)) {
            indexers.push(mapType(m.type, { ...ctx, pos: "other" }));
            continue;
        }
        if (ts.isConstructorDeclaration(m) || ts.isConstructSignatureDeclaration(m) || ts.isCallSignatureDeclaration(m)) continue;
        if (ts.isClassStaticBlockDeclaration(m)) continue;
        const nameNode = (m as { name?: ts.PropertyName }).name;
        const name = nameNode && memberName(nameNode);
        if (!name) continue;
        if (ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) {
            const a = accessors.get(name) ?? {};
            if (ts.isGetAccessorDeclaration(m)) a.get = m;
            else a.set = m;
            accessors.set(name, a);
            continue;
        }
        if (inClass && ts.isPropertyDeclaration(m) && m.type && !m.questionToken && !HOOK.test(name)) {
            const ft = unparen(m.type);
            if (ts.isFunctionTypeNode(ft)) {
                const before = opaqueHits;
                const mctx = methodCtx(ctx, ft.typeParameters, name);
                const ret = ft.type.kind === SK.AnyKeyword ? "obj" : mapType(ft.type, { ...mctx, pos: "return" });
                const ps = params(ft.parameters, mctx);
                if (!(opaqueHits > before && (isObjish(ret) || ps.some((p) => isObjish(p.type)))))
                    methods.push({ name, params: ps, ret, doc: docOf(m), isStatic: isStatic(m), typeParams: [] });
                continue;
            }
        }
        if (ts.isPropertyDeclaration(m) || ts.isPropertySignature(m)) {
            const doc = docOf(m);
            // A property holding a function whose own parameters are optional is still a
            // property: F# code assigns or reads it rather than calling it as a method.
            const before = opaqueHits;
            const type = mapType(m.type, propTypeCtx(ctx, name));
            // Typed only by the WebGPU node system (`colorNode`, `lightsNode` on every
            // material): meaningless under WebGL and nothing but `obj` here.
            if (opaqueHits > before && isObjish(type)) continue;
            props.push({
                name,
                type,
                readonly: isReadonly(m),
                optional: !!m.questionToken,
                doc,
                isStatic: isStatic(m),
            });
            continue;
        }
        if (inClass && ts.isMethodDeclaration(m) && HOOK.test(name)) {
            if (props.some((p) => p.name === name)) continue;
            const mctx = methodCtx(ctx, m.typeParameters, name);
            props.push({ name, type: mapFunction(m.parameters, m.type, mctx), readonly: false, optional: false, doc: docOf(m), isStatic: isStatic(m) });
            continue;
        }
        if (ts.isMethodDeclaration(m) || ts.isMethodSignature(m)) {
            if ((m as ts.MethodDeclaration).asteriskToken) continue;
            const before = opaqueHits;
            const mctx = methodCtx(ctx, m.typeParameters, name);
            const ps = params(m.parameters, mctx);
            // `setValues(values?: MeshStandardMaterialParameters)`: calling it with nothing does
            // nothing, and an optional argument would make `setValues()` ambiguous between the
            // material's overload and Material's.
            if (ps.length === 1 && ps[0].optional && pojoOf(ps[0].type)) ps[0].optional = false;
            let ret = mapType(m.type, { ...mctx, pos: "return" });
            if (!m.type) ret = "unit";
            // A method that takes or returns a node (`setIndirect(IndirectStorageBufferAttribute)`)
            // only works with the WebGPU renderer.
            if (opaqueHits > before && (isObjish(ret) || ps.some((p) => isObjish(p.type)))) continue;
            methods.push({ name, params: ps, ret, doc: docOf(m), isStatic: isStatic(m), typeParams: [] });
        }
    }
    for (const [name, a] of accessors) {
        const before = opaqueHits;
        const t = a.get ? mapType(a.get.type, propTypeCtx(ctx, name)) : mapType(a.set!.parameters[0]?.type, propTypeCtx(ctx, name));
        if (opaqueHits > before && isObjish(t)) continue;
        props.push({ name, type: t, readonly: !a.set, optional: false, doc: docOf(a.get ?? a.set), isStatic: isStatic((a.get ?? a.set)!) });
    }
    return { props, methods, indexers };
}

function emitProp(p: PropSpec, out: Out, indent: string, emitAs?: string) {
    out.push(...docLines(p.doc, indent));
    out.push(...obsolete(p.doc, indent));
    const kw = p.isStatic ? "static member" : "member _.";
    const n = ident(emitAs ?? p.name);
    const decl = p.isStatic ? `${kw} ${n}` : `${kw}${n}`;
    if (emitAs) {
        out.push(`${indent}${decl}`);
        out.push(`${indent}    with [<Emit(${str("$0." + p.name)})>] get () : ${p.type} = jsNative`);
        if (!p.readonly) out.push(`${indent}    and [<Emit(${str("$0." + p.name + " = $1")})>] set (_: ${p.type}) = jsNative`);
        return;
    }
    if (p.readonly) out.push(`${indent}${decl} : ${p.type} = jsNative`);
    else out.push(`${indent}${decl} with get () : ${p.type} = jsNative and set (_: ${p.type}) = jsNative`);
}

function emitMethod(m: MethodSpec, out: Out, indent: string, owner: Entry, seen: Set<string>, rename?: string) {
    const override = memberOverrides[`${m.declaredIn ?? owner.fsName}.${m.name}`];
    if (override) {
        for (const o of override) {
            const key = (m.isStatic ? "static " : "") + m.name + "(" + o.params + ")";
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(...docLines(m.doc, indent));
            if (o.emit) out.push(`${indent}[<Emit(${str(o.emit)})>]`);
            out.push(`${indent}${m.isStatic ? "static member " : "member _."}${ident(m.name)}(${o.params}) : ${o.ret ?? m.ret} = jsNative`);
        }
        return;
    }
    for (const ps of expand(m.params)) {
        const key = sigKey(m.name, ps, m.isStatic);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(...docLines(m.doc, indent));
        out.push(...obsolete(m.doc, indent));
        const n = ident(rename ?? m.name);
        const kw = m.isStatic ? "static member " : "member _.";
        if (rename) {
            const emit = m.isStatic
                ? `[<Emit(${str("$0." + m.name + "($1...)")})>]`
                : `[<Emit(${str("$0." + m.name + "($1...)")})>]`;
            out.push(`${indent}${emit}`);
        }
        out.push(`${indent}${kw}${n}(${paramList(ps)}) : ${m.ret} = jsNative`);
    }
}

type Link = { entry: Entry; decl: ts.ClassDeclaration; ctx: Ctx; ownCtx: Ctx; baseType?: string };

/**
 * Ancestors of a class, nearest first. `ctx` maps a link's type parameters to what the
 * derived class pinned them to (`DirectionalLightShadow extends LightShadow<OrthographicCamera>`);
 * `ownCtx` is the erased view the ancestor itself is emitted under.
 */
function classChain(e: Entry): Link[] {
    const out: Link[] = [];
    const thisType = classSelfType(e);
    let cur: Entry | undefined = e;
    let ctx = typeParamCtx(e, { ...baseCtx(e), thisType, owner: e.fsName });
    let guard = 0;
    while (cur && guard++ < 30) {
        const decl = cur.symbol.declarations?.find(ts.isClassDeclaration);
        if (!decl) break;
        const ownCtx = typeParamCtx(cur, { ...baseCtx(cur), thisType, owner: cur.fsName });
        const ext = decl.heritageClauses?.find((h) => h.token === SK.ExtendsKeyword)?.types[0];
        let next: Entry | undefined;
        let baseType: string | undefined;
        if (ext) {
            const s0 = checker.getSymbolAtLocation(ext.expression);
            const s = s0 && resolveAlias(s0);
            if (s && inThree(fileOf(s))) {
                next = lookup(s);
                if (next && next.kind === "class") baseType = mapTypeRef(ext, { ...ownCtx, pos: "other" });
                else next = undefined;
            }
        }
        out.push({ entry: cur, decl, ctx, ownCtx, baseType });
        if (!next || !ext) break;
        const nextCtx = typeParamCtx(next, { ...baseCtx(next), thisType, owner: next.fsName });
        const tps = typeParamsOf(next);
        const args = ext.typeArguments ?? [];
        const m = new Map(nextCtx.tparams);
        tps.forEach((tp, i) => {
            if (args[i]) m.set(tp.name.text, mapType(args[i], { ...ctx, pos: "other" }));
        });
        ctx = { ...nextCtx, tparams: m };
        cur = next;
    }
    return out;
}

/**
 * Members a class gets from interfaces merged into it: @types/three declares
 * `interface MeshStandardMaterial extends MeshStandardMaterialProperties {}` beside the class,
 * which is where `color`, `roughness` and the rest live.
 */
function mergedMembers(e: Entry, ctx: Ctx) {
    const props: PropSpec[] = [];
    const methods: MethodSpec[] = [];
    const visited = new Set<ts.Symbol>();
    const visitDecls = (ds: readonly ts.InterfaceDeclaration[], c: Ctx) => {
        for (const d of ds) {
            const m = collectMembers(d.members, c);
            props.push(...m.props);
            methods.push(...m.methods);
            for (const h of d.heritageClauses ?? [])
                for (const t of h.types) {
                    const u = unwrap(t, { optional: false, colors: false });
                    if (!u || visited.has(u.symbol)) continue;
                    visited.add(u.symbol);
                    const inner = (u.symbol.declarations ?? []).filter(ts.isInterfaceDeclaration);
                    visitDecls(inner, withTypeArgs(inner[0]?.typeParameters, u.args, c));
                }
        }
    };
    visitDecls((e.symbol.declarations ?? []).filter(ts.isInterfaceDeclaration), ctx);
    return { props, methods };
}

function linkProps(l: Link, ctx: Ctx): PropSpec[] {
    return [...collectMembers(l.decl.members, ctx, true).props, ...mergedMembers(l.entry, ctx).props];
}

/**
 * `Controls.update(delta)` beside `OrbitControls.update(deltaTime?)`: same types, different
 * optionality, so F# keeps both and `controls.update(dt)` is ambiguous. Before emitting,
 * every redeclaration and the ancestor member it redeclares agree on the more permissive
 * optionality; the signatures then match and the subclass's hides the base's.
 */
const optionalMasks = new Map<string, boolean[]>();

function maskKey(owner: string, m: MethodSpec): string {
    return `${owner}.${m.name}(${m.params.map((p) => p.type).join(",")})`;
}

function unifyOptionality() {
    let changed = true;
    for (let round = 0; changed && round < 5; round++) {
        changed = false;
        for (const e of [...entries]) {
            if (e.kind !== "class") continue;
            const chain = classChain(e);
            const own = [...collectMembers(chain[0].decl.members, chain[0].ctx, true).methods, ...mergedMembers(e, chain[0].ctx).methods];
            for (const m of own) {
                if (m.isStatic) continue;
                for (const link of chain.slice(1)) {
                    const viewed = [...collectMembers(link.decl.members, link.ctx, true).methods, ...mergedMembers(link.entry, link.ctx).methods];
                    const native = [...collectMembers(link.decl.members, link.ownCtx, true).methods, ...mergedMembers(link.entry, link.ownCtx).methods];
                    viewed.forEach((a, i) => {
                        if (a.name !== m.name || a.isStatic || a.params.length !== m.params.length) return;
                        if (!a.params.every((p, j) => p.type === m.params[j].type && p.rest === m.params[j].rest)) return;
                        const mk = maskKey(e.fsName, m);
                        const ak = maskKey(link.entry.fsName, native[i]);
                        const mm = optionalMasks.get(mk) ?? m.params.map((p) => p.optional);
                        const am = optionalMasks.get(ak) ?? a.params.map((p) => p.optional);
                        const merged = mm.map((o, j) => o || am[j]);
                        if (merged.some((o, j) => o !== mm[j]) || merged.some((o, j) => o !== am[j])) changed = true;
                        optionalMasks.set(mk, merged);
                        optionalMasks.set(ak, merged);
                    });
                }
            }
        }
    }
}

function applyMask(owner: string, m: MethodSpec): MethodSpec {
    const mask = optionalMasks.get(maskKey(owner, m));
    if (!mask) return m;
    const ps = m.params.map((p, i) => ({ ...p, optional: p.optional || mask[i] }));
    // Still optional-last: once one argument is optional, the rest are.
    let seen = false;
    for (const p of ps) {
        if (p.rest) continue;
        if (p.optional) seen = true;
        else if (seen) p.optional = true;
    }
    return { ...m, params: ps };
}

/**
 * `Camera.clone()` beside `Object3D.clone(recursive?)`: F# sees two overloads and `camera.clone()`
 * matches both. When an ancestor's overload is this method plus trailing optional arguments,
 * take its parameter list so the signatures are identical and the subclass's hides the base's.
 */
function widenToAncestor(m: MethodSpec, chain: Link[]): MethodSpec {
    if (m.isStatic) return m;
    for (const link of chain.slice(1)) {
        const viewed = [...collectMembers(link.decl.members, link.ctx, true).methods, ...mergedMembers(link.entry, link.ctx).methods];
        const native = [...collectMembers(link.decl.members, link.ownCtx, true).methods, ...mergedMembers(link.entry, link.ownCtx).methods];
        // As the ancestor will be emitted: with its unified optionality.
        const candidates = viewed
            .map((a, i) => {
                const mask = optionalMasks.get(maskKey(link.entry.fsName, native[i]));
                return mask ? { ...a, params: a.params.map((p, j) => ({ ...p, optional: p.optional || mask[j] })) } : a;
            })
            .filter((a) => a.name === m.name && !a.isStatic);
        for (const a of candidates) {
            if (a.params.length <= m.params.length) continue;
            const prefixMatches = m.params.every((p, i) => a.params[i].type === p.type && a.params[i].optional === p.optional && !p.rest);
            const restOptional = a.params.slice(m.params.length).every((p) => p.optional && !p.rest);
            if (prefixMatches && restOptional) return { ...m, params: [...m.params, ...a.params.slice(m.params.length)] };
        }
    }
    return m;
}

const emittedPropsCache = new Map<Entry, PropSpec[]>();

/**
 * The properties a class declares in F#: its own, and inherited ones whose type the class
 * pins down further (`shadow.camera` is an OrthographicCamera on a DirectionalLight).
 * Redeclaring a property hides the base one cleanly in F#, unlike a method overload.
 */
function emittedProps(e: Entry): PropSpec[] {
    const cached = emittedPropsCache.get(e);
    if (cached) return cached;
    emittedPropsCache.set(e, []);
    const chain = classChain(e);
    const baseVisible = chain[1] ? visibleProps(chain[1].entry) : new Map<string, PropSpec>();
    const out: PropSpec[] = [];
    const names = new Set<string>();
    for (const p of linkProps(chain[0], chain[0].ctx)) {
        const key = (p.isStatic ? "static " : "") + p.name;
        if (names.has(key)) continue;
        names.add(key);
        if (!p.isStatic && baseVisible.get(p.name)?.type === p.type) continue;
        out.push(p);
    }
    for (const link of chain.slice(1)) {
        for (const p of linkProps(link, link.ctx)) {
            if (p.isStatic || names.has(p.name)) continue;
            names.add(p.name);
            const vis = baseVisible.get(p.name);
            if (vis && vis.type !== p.type) out.push(p);
        }
    }
    emittedPropsCache.set(e, out);
    return out;
}

function visibleProps(e: Entry): Map<string, PropSpec> {
    const chain = classChain(e);
    const m = chain[1] ? new Map(visibleProps(chain[1].entry)) : new Map<string, PropSpec>();
    for (const p of emittedProps(e)) if (!p.isStatic) m.set(p.name, p);
    return m;
}

function classSelfType(e: Entry): string {
    const kept = keptParams(e);
    return kept.length ? `${e.fsName}<${kept.map((k) => "'" + k).join(", ")}>` : e.fsName;
}

function ctorSpecs(e: Entry): { params: Param[]; doc?: Doc }[][] {
    for (const link of classChain(e)) {
        // Protected constructors are kept: F# subclasses of an abstract class need one.
        const ctors = link.decl.members.filter(ts.isConstructorDeclaration).filter((c) => !isPrivateOnly(c));
        const hasCtorDecl = link.decl.members.some(ts.isConstructorDeclaration);
        if (hasCtorDecl) {
            return ctors.map((c) => {
                const ps = params(c.parameters, { ...link.ctx, member: "" , owner: e.fsName, thisType: classSelfType(e) });
                return expand(ps).map((v) => ({ params: v, doc: docOf(c) }));
            });
        }
    }
    return [[{ params: [] }]];
}

/** The POJO a lone options argument can be flattened from, if it is one. */
function pojoOf(t: string): Entry | undefined {
    const e = entries.find((x) => x.fsName === t && x.kind === "pojo");
    return e;
}

function baseCtorArgs(base: Entry | undefined): string {
    if (!base) return "";
    const specs = ctorSpecs(base).flat();
    const first = specs[0];
    if (!first) return "";
    const req = first.params.filter((p) => !p.optional && !p.rest);
    if (req.length === 0) return "";
    return req.map((p) => `Unchecked.defaultof<${p.type}>`).join(", ");
}

function emitClass(e: Entry, out: Out) {
    const chain = classChain(e);
    const self = chain[0];
    const decl = self.decl;
    const doc = docOf(decl);
    const kept = keptParams(e);
    const generics = kept.length ? `<${kept.map((k) => "'" + k).join(", ")}>` : "";
    const importable = !!e.exportName;
    const baseEntry = chain[1]?.entry;
    const baseType = self.baseType;

    header(out, doc);
    out.push("[<AllowNullLiteral>]");
    out.push(importable ? importAttr(e) : "[<Global>]");
    out.push(`type ${e.fsName}${generics} =`);
    if (baseType) out.push(`    inherit ${baseType}`);
    const body: Out = [];
    const init = baseType ? `{ inherit ${baseType}(${baseCtorArgs(baseEntry)}) }` : "{ }";

    // Constructors.
    const seenCtor = new Set<string>();
    for (const variants of ctorSpecs(e)) {
        for (const v of variants) {
            const key = sigKey("new", v.params, false);
            if (seenCtor.has(key)) continue;
            seenCtor.add(key);
            const lone = v.params.length === 1 ? v.params[0] : undefined;
            const pojo = lone && !lone.rest ? pojoOf(lone.type) : undefined;
            body.push(...docLines(v.doc, "    "));
            if (pojo) {
                // `new MeshStandardMaterial(parameters)` and `MeshStandardMaterial(color = ..., roughness = ...)`.
                body.push(`    new (${paramList([{ ...lone!, optional: false }])}) = ${init}`);
                const flat = pojoParams(pojo);
                const fkey = sigKey("new", flat, false);
                if (flat.length > 0 && !seenCtor.has(fkey)) {
                    seenCtor.add(fkey);
                    body.push(...docLines(v.doc, "    "));
                    body.push("    [<ParamObject>]");
                    body.push(`    new (${paramList(flat)}) = ${init}`);
                }
            } else body.push(`    new (${paramList(v.params)}) = ${init}`);
        }
    }

    const own = collectMembers(decl.members, self.ctx, true);
    const merged = mergedMembers(e, self.ctx);
    const props = emittedProps(e);
    const methods = [...own.methods, ...merged.methods.filter((m) => !own.methods.some((o) => o.name === m.name))].map((m) =>
        widenToAncestor(m.isStatic ? m : applyMask(e.fsName, m), chain),
    );
    const seenSig = new Set<string>();
    const propNames = new Set<string>();
    const methodNames = new Set(methods.map((m) => (m.isStatic ? "static " : "") + m.name));
    for (const p of props) {
        const key = (p.isStatic ? "static " : "") + p.name;
        if (propNames.has(key)) continue;
        propNames.add(key);
        const clash = methodNames.has(key) || (p.isStatic ? propNames.has(p.name) : propNames.has("static " + p.name));
        emitProp(p, body, "    ", clash ? p.name + "Property" : undefined);
        if (p.name === "material" && e.fsName !== "Material" && !p.isStatic)
            emitProp({ ...p, name: "material", type: `${p.type}[]`, doc: { summary: "The materials of a multi-material object: the same JS property as `material`, typed as an array." } }, body, "    ", "materials");
    }
    for (const m of methods) {
        const key = (m.isStatic ? "static " : "") + m.name;
        const clash = propNames.has(key) || (!m.isStatic && propNames.has("static " + m.name)) || (m.isStatic && methods.some((x) => !x.isStatic && x.name === m.name));
        emitMethod(m, body, "    ", e, seenSig, clash ? m.name + (m.isStatic ? "Static" : "Method") : undefined);
    }
    // Inherited methods returning `this`: re-declared so `mesh.clone()` is a Mesh.
    if (chain.length > 1) {
        const ownNames = new Set([...methods.map((m) => m.name), ...props.map((p) => p.name)]);
        // The nearest ancestor declaring a name supplies its overloads; farther ones are
        // what it already overrides (`Camera.clone()` over `Object3D.clone(recursive?)`).
        const claimed = new Set<string>();
        chain.slice(1).forEach((link, i) => {
            const here = new Set<string>();
            for (const m of link.decl.members) {
                if (!(ts.isMethodDeclaration(m) && !isPrivate(m) && !isStatic(m))) continue;
                const name = memberName(m.name);
                if (!name || ownNames.has(name) || HOOK.test(name) || claimed.has(name)) continue;
                here.add(name);
                if (!m.type || m.type.kind !== SK.ThisType) continue;
                const mctx = methodCtx(link.ctx, m.typeParameters, name);
                const nativePs = params(m.parameters, methodCtx(link.ownCtx, m.typeParameters, name));
                const mask = optionalMasks.get(`${link.entry.fsName}.${name}(${nativePs.map((p) => p.type).join(",")})`);
                const ps = params(m.parameters, mctx).map((p, j) => ({ ...p, optional: p.optional || !!mask?.[j] }));
                const spec = widenToAncestor(
                    { name, params: ps, ret: classSelfType(e), doc: docOf(m), isStatic: false, typeParams: [], declaredIn: link.entry.fsName },
                    chain.slice(i + 1),
                );
                emitMethod(spec, body, "    ", e, seenSig);
            }
            for (const n of here) claimed.add(n);
        });
    }
    out.push(...body);
}

type Wrap = { optional: boolean; colors: boolean };

/**
 * `Partial<MapColorPropertiesToColorRepresentations<MeshStandardMaterialProperties>>`, the
 * way @types/three spells a parameter bag: the symbol underneath and what the wrappers do
 * to its properties (every one optional; Color widened to ColorRepresentation).
 */
function unwrap(t: ts.ExpressionWithTypeArguments | ts.TypeNode, wrap: Wrap): { symbol: ts.Symbol; args: readonly ts.TypeNode[]; wrap: Wrap } | undefined {
    const nameNode = ts.isExpressionWithTypeArguments(t) ? t.expression : ts.isTypeReferenceNode(t) ? t.typeName : undefined;
    if (!nameNode) return undefined;
    const args = (t as ts.ExpressionWithTypeArguments).typeArguments ?? [];
    const name = nameNode.getText();
    if (name === "Partial" && args[0]) return unwrap(args[0], { ...wrap, optional: true });
    if ((name === "Readonly" || name === "Required") && args[0]) return unwrap(args[0], wrap);
    if (name === "MapColorPropertiesToColorRepresentations" && args[0]) return unwrap(args[0], { ...wrap, colors: true });
    const s0 = checker.getSymbolAtLocation(nameNode);
    const s = s0 && resolveAlias(s0);
    if (!s || !inThree(fileOf(s))) return undefined;
    return { symbol: s, args, wrap };
}

function colorRepr(ctx: Ctx): string {
    const e = entries.find((x) => x.fsName === "ColorRepresentation" && x.target === targets[0]);
    return e ? ref(e, ctx) : "obj";
}

function applyWrap(p: PropSpec, wrap: Wrap, ctx: Ctx): PropSpec {
    let type = p.type;
    if (wrap.colors && (type === "Color" || type === "Three.Color")) type = colorRepr(ctx);
    return { ...p, type, optional: p.optional || wrap.optional };
}

/** Every property a POJO carries, its ancestors' included, as ParamObject arguments. */
function pojoProps(e: Entry): PropSpec[] {
    const seen = new Map<string, PropSpec>();
    const add = (ps: PropSpec[], wrap: Wrap, ctx: Ctx) => {
        for (const p of ps) if (!seen.has(p.name)) seen.set(p.name, applyWrap(p, wrap, ctx));
    };
    const visited = new Set<ts.Symbol>();
    const visitSymbol = (sym: ts.Symbol, ctx: Ctx, wrap: Wrap) => {
        if (visited.has(sym)) return;
        visited.add(sym);
        for (const d of sym.declarations ?? []) {
            if (ts.isInterfaceDeclaration(d)) {
                add(collectMembers(d.members, ctx).props, wrap, ctx);
                for (const h of d.heritageClauses ?? [])
                    for (const t of h.types) {
                        const u = unwrap(t, wrap);
                        if (!u) continue;
                        visitSymbol(u.symbol, withTypeArgs(typeParamsOfIface(u.symbol), u.args, ctx), u.wrap);
                    }
            } else if (ts.isTypeAliasDeclaration(d)) {
                const t = unparen(d.type);
                if (ts.isTypeLiteralNode(t)) add(collectMembers(t.members, withTypeArgs(d.typeParameters, [], ctx)).props, wrap, ctx);
            }
        }
    };
    const none: Wrap = { optional: false, colors: false };
    if (e.literal) add(collectMembers(e.literal.members, e.literal.ctx).props, none, e.literal.ctx);
    else visitSymbol(e.symbol, typeParamCtx(e, baseCtx(e)), none);
    return [...seen.values()];
}

function typeParamsOfIface(s: ts.Symbol): readonly ts.TypeParameterDeclaration[] | undefined {
    return s.declarations?.find(ts.isInterfaceDeclaration)?.typeParameters;
}

function pojoParams(e: Entry): Param[] {
    const ps = pojoProps(e).map((p) => ({
        name: p.name,
        type: p.type.endsWith(" option") ? p.type.slice(0, -" option".length).replace(/^\((.*)\)$/, "$1") : p.type,
        optional: p.optional,
        rest: false,
    }));
    return [...ps.filter((p) => !p.optional), ...ps.filter((p) => p.optional)];
}

/** The nearest POJO this one extends, which F# can inherit from. */
function pojoBase(e: Entry): { entry: Entry; type: string } | undefined {
    const d = e.symbol?.declarations?.find(ts.isInterfaceDeclaration);
    const first = d?.heritageClauses?.[0]?.types[0];
    if (!first) return undefined;
    const u = unwrap(first, { optional: false, colors: false });
    if (!u) return undefined;
    const direct = lookup(u.symbol);
    if (u.symbol !== undefined && direct && direct.kind === "pojo" && !isWrapped(first)) return { entry: direct, type: ref(direct, baseCtx(e)) };
    // `Partial<Map<XProperties>>`: inherit from the parameters built on XProperties' base.
    const props = u.symbol.declarations?.find(ts.isInterfaceDeclaration);
    const baseProps = props?.heritageClauses?.[0]?.types[0];
    if (!baseProps) return undefined;
    const bu = unwrap(baseProps, { optional: false, colors: false });
    if (!bu) return undefined;
    const wrapped = wrappedPojos().get(bu.symbol);
    return wrapped ? { entry: wrapped, type: ref(wrapped, baseCtx(e)) } : undefined;
}

function isWrapped(t: ts.ExpressionWithTypeArguments): boolean {
    return ["Partial", "MapColorPropertiesToColorRepresentations", "Readonly", "Required"].includes(t.expression.getText());
}

let wrappedCache: Map<ts.Symbol, Entry> | undefined;
/** Parameter POJOs keyed by the `XProperties` interface they wrap. */
function wrappedPojos(): Map<ts.Symbol, Entry> {
    if (wrappedCache) return wrappedCache;
    wrappedCache = new Map();
    for (const e of entries) {
        if (e.kind !== "pojo" || !e.symbol) continue;
        const first = e.symbol.declarations?.find(ts.isInterfaceDeclaration)?.heritageClauses?.[0]?.types[0];
        if (!first || !isWrapped(first)) continue;
        const u = unwrap(first, { optional: false, colors: false });
        if (u && !wrappedCache.has(u.symbol)) wrappedCache.set(u.symbol, e);
    }
    return wrappedCache;
}

function emitPojo(e: Entry, out: Out) {
    const decl = e.symbol?.declarations?.find((d) => ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d));
    const doc = decl ? docOf(decl) : undefined;
    const base = pojoBase(e);
    const ctx = e.literal ? e.literal.ctx : typeParamCtx(e, baseCtx(e));
    let indexers: string[] = [];
    if (e.literal) indexers = collectMembers(e.literal.members, ctx).indexers;
    else if (decl && ts.isInterfaceDeclaration(decl))
        for (const d of e.symbol.declarations!.filter(ts.isInterfaceDeclaration)) indexers.push(...collectMembers(d.members, ctx).indexers);
    else if (decl) {
        const t = unparen((decl as ts.TypeAliasDeclaration).type) as ts.TypeLiteralNode;
        indexers = collectMembers(t.members, typeParamCtxForAlias(e, decl as ts.TypeAliasDeclaration)).indexers;
    }
    // Everything the base does not already declare with the same type; properties from a
    // base F# cannot inherit (a second `extends`) are flattened in.
    const all = pojoProps(e);
    const baseProps = new Map((base ? pojoProps(base.entry) : []).map((p) => [p.name, p.type]));
    const members = all.filter((p) => baseProps.get(p.name) !== p.type);

    header(out, doc);
    out.push("[<AllowNullLiteral; Global>]");
    out.push(`type ${e.fsName} =`);
    if (base) out.push(`    inherit ${base.type}`);
    const init = base ? `{ inherit ${base.type}(${pojoBaseArgs(base.entry)}) }` : "{ }";
    const ps = pojoParams(e);
    if (ps.length === 0) {
        out.push(`    [<Emit("{}")>]`);
        out.push(`    new () = ${init}`);
    } else {
        out.push(`    [<ParamObject; Emit("$0")>]`);
        out.push(`    new (${paramList(ps)}) = ${init}`);
    }
    for (const p of members) emitProp({ ...p, readonly: false, isStatic: false }, out, "    ");
    if (indexers.length > 0) {
        out.push("    [<EmitIndexer>]");
        out.push(`    member _.Item with get (key: string) : ${indexers[0]} = jsNative and set (key: string) (_: ${indexers[0]}) = jsNative`);
    }
}

function pojoBaseArgs(base: Entry): string {
    const req = pojoParams(base).filter((p) => !p.optional);
    return req.map((p) => `Unchecked.defaultof<${p.type}>`).join(", ");
}

function emitInterface(e: Entry, out: Out) {
    const ds = e.literal ? [] : (e.symbol.declarations ?? []).filter(ts.isInterfaceDeclaration);
    const doc = ds[0] ? docOf(ds[0]) : undefined;
    const ctx = e.literal ? e.literal.ctx : typeParamCtx(e, baseCtx(e));
    const bases: string[] = [];
    const members: (ts.TypeElement)[] = e.literal ? [...e.literal.members] : ds.flatMap((d) => [...d.members]);
    for (const d of ds)
        for (const h of d.heritageClauses ?? [])
            for (const t of h.types) {
                const s0 = checker.getSymbolAtLocation(t.expression);
                const s = s0 && resolveAlias(s0);
                if (!s || !inThree(fileOf(s))) continue;
                const be = lookup(s);
                if (be && be.kind === "interface") bases.push(ref(be, ctx));
                else if (be) {
                    // A POJO or class base: F# interfaces cannot inherit those, so copy its members.
                    for (const bd of be.symbol?.declarations ?? []) if (ts.isInterfaceDeclaration(bd)) members.push(...bd.members);
                }
            }
    const { props, methods, indexers } = collectMembers(members, ctx);
    header(out, doc);
    out.push("[<AllowNullLiteral; Interface>]");
    out.push(`type ${e.fsName} =`);
    for (const b of unique(bases)) out.push(`    inherit ${b}`);
    const seen = new Set<string>();
    const propNames = new Set<string>();
    for (const p of props) {
        if (propNames.has(p.name)) continue;
        propNames.add(p.name);
        out.push(...docLines(p.doc, "    "));
        out.push(`    abstract ${ident(p.name)}: ${p.type}${p.readonly ? "" : " with get, set"}`);
    }
    for (const m of methods) {
        if (propNames.has(m.name)) continue;
        for (const ps of expand(m.params)) {
            const key = sigKey(m.name, ps, false);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(...docLines(m.doc, "    "));
            const args = ps.length === 0 ? "unit" : ps.map((p) => (p.rest ? `[<System.ParamArray>] ${ident(p.name)}: ${p.type}` : `${p.optional ? "?" : ""}${ident(p.name)}: ${atomArg(p.type)}`)).join(" * ");
            out.push(`    abstract ${ident(m.name)}: ${args} -> ${atomArg(m.ret)}`);
        }
    }
    if (indexers.length > 0) {
        out.push("    [<EmitIndexer>]");
        out.push(`    abstract Item: key: string -> ${indexers[0]} with get, set`);
    }
    if (props.length === 0 && methods.length === 0 && indexers.length === 0 && bases.length === 0)
        out.push("    interface end");
}

function atomArg(t: string): string {
    return t.includes("->") || t.includes(" * ") ? (t.startsWith("(") && t.endsWith(")") ? t : `(${t})`) : t;
}

function emitStatics(e: Entry, out: Out) {
    const ctx = baseCtx(e);
    const props: PropSpec[] = [];
    const methods: MethodSpec[] = [];
    let doc: Doc | undefined;
    const variable = e.symbol.declarations?.find(ts.isVariableDeclaration);
    const merged = e.symbol.declarations?.filter(ts.isInterfaceDeclaration) ?? [];
    const literalMembers: ts.TypeElement[] | undefined =
        variable?.type && ts.isTypeLiteralNode(variable.type) ? [...variable.type.members]
        : variable && merged.length > 0 ? merged.flatMap((d) => [...d.members]) : undefined;
    if (variable && literalMembers) {
        doc = docOf(variable.parent.parent) ?? docOf(merged[0]);
        for (const m of literalMembers) {
            const name = m.name && memberName(m.name);
            if (!name) continue;
            if (ts.isMethodSignature(m)) {
                const mctx = methodCtx(ctx, m.typeParameters, name);
                methods.push({ name, params: params(m.parameters, mctx), ret: m.type ? mapType(m.type, { ...mctx, pos: "return" }) : "unit", doc: docOf(m), isStatic: true, typeParams: [] });
            } else if (ts.isPropertySignature(m) && m.type) {
                const fdecls = functionDeclsOf(m.type);
                if (fdecls.length > 0)
                    for (const f of fdecls) {
                        const mctx = methodCtx(ctx, f.typeParameters, name);
                        methods.push({ name, params: params(f.parameters, mctx), ret: f.type ? mapType(f.type, { ...mctx, pos: "return" }) : "unit", doc: docOf(f), isStatic: true, typeParams: [] });
                    }
                else if (ts.isFunctionTypeNode(m.type)) {
                    const mctx = methodCtx(ctx, m.type.typeParameters, name);
                    methods.push({ name, params: params(m.type.parameters, mctx), ret: mapType(m.type.type, { ...mctx, pos: "return" }), doc: docOf(m), isStatic: true, typeParams: [] });
                } else props.push({ name, type: mapType(m.type, propTypeCtx(ctx, name)), readonly: true, optional: false, doc: docOf(m), isStatic: true });
            }
        }
    } else {
        // A module re-exported as a namespace (`export * as BufferGeometryUtils`).
        const exports = checker.getExportsOfModule(e.symbol);
        for (const ex of exports) {
            const r = resolveAlias(ex);
            for (const d of r.declarations ?? []) {
                if (ts.isFunctionDeclaration(d)) {
                    const mctx = methodCtx(ctx, d.typeParameters, ex.name);
                    methods.push({ name: ex.name, params: params(d.parameters, mctx), ret: d.type ? mapType(d.type, { ...mctx, pos: "return" }) : "unit", doc: docOf(d), isStatic: true, typeParams: [] });
                } else if (ts.isVariableDeclaration(d)) {
                    props.push({ name: ex.name, type: mapType(d.type, propTypeCtx(ctx, ex.name)), readonly: true, optional: false, doc: docOf(d.parent.parent), isStatic: true });
                } else if (ts.isClassDeclaration(d) || ts.isInterfaceDeclaration(d) || ts.isTypeAliasDeclaration(d) || ts.isEnumDeclaration(d)) {
                    // Types inside a namespace module are bound on their own.
                    if (!bySymbol.has(r)) register(r, e.target, undefined, true);
                }
            }
        }
    }
    header(out, doc);
    out.push("[<AbstractClass>]");
    out.push(importAttr(e));
    out.push(`type ${e.fsName} =`);
    const seen = new Set<string>();
    const propNames = new Set<string>();
    for (const p of props) {
        if (propNames.has(p.name)) continue;
        propNames.add(p.name);
        emitProp(p, out, "    ");
    }
    for (const m of methods) emitMethod(m, out, "    ", e, seen, propNames.has(m.name) ? m.name + "Method" : undefined);
    if (props.length === 0 && methods.length === 0) out.push("    class end");
}

function functionDeclsOf(t: ts.TypeNode): ts.FunctionDeclaration[] {
    if (!ts.isTypeQueryNode(t)) return [];
    const s0 = checker.getSymbolAtLocation(t.exprName);
    const s = s0 && resolveAlias(s0);
    return (s?.declarations ?? []).filter(ts.isFunctionDeclaration);
}

/** The literal behind `export const FrontSide: 0` / `export const SRGBColorSpace: "srgb"`. */
function literalValue(e: Entry): number | string | undefined {
    const v = e.symbol.declarations?.find(ts.isVariableDeclaration);
    const t = v?.type;
    if (!t || !ts.isLiteralTypeNode(t)) return undefined;
    if (ts.isNumericLiteral(t.literal)) return Number(t.literal.text);
    if (ts.isPrefixUnaryExpression(t.literal) && ts.isNumericLiteral(t.literal.operand)) return -Number(t.literal.operand.text);
    if (ts.isStringLiteral(t.literal)) return t.literal.text;
    return undefined;
}

function literalLine(e: Entry): string[] {
    const v = literalValue(e)!;
    const doc = docOf(e.symbol.declarations?.[0]?.parent?.parent);
    const lit = typeof v === "string" ? str(v) : Number.isInteger(v) ? String(v) : String(v) + (String(v).includes(".") ? "" : ".0");
    return [...docLines(doc, "    "), ...obsolete(doc, "    "), "    [<Literal>]", `    let ${ident(e.fsName)} = ${lit}`];
}

// Values and functions are gathered per namespace and written as one block each.
function valueLine(e: Entry): string[] {
    const v = e.symbol.declarations?.find(ts.isVariableDeclaration)!;
    const ctx = baseCtx(e);
    let t = mapType(v.type, { ...ctx, pos: "prop", member: "Definition" });
    if (v.type && ts.isLiteralTypeNode(v.type) && ts.isNumericLiteral(v.type.literal) && Number.isInteger(Number(v.type.literal.text)))
        t = "int";
    const doc = docOf(v.parent.parent);
    return [...docLines(doc, "    "), ...obsolete(doc, "    "), `    [<Import(${str(e.exportName!)}, ${str(e.module)})>]`, `    let ${ident(e.fsName)}: ${t} = jsNative`];
}

function functionLines(e: Entry, seen: Set<string>): string[] {
    const out: string[] = [];
    const ctx = baseCtx(e);
    for (const f of (e.symbol.declarations ?? []).filter(ts.isFunctionDeclaration)) {
        const mctx = methodCtx(ctx, f.typeParameters, e.fsName);
        const ps = params(f.parameters, mctx);
        const ret = f.type ? mapType(f.type, { ...mctx, pos: "return" }) : "unit";
        for (const v of expand(ps)) {
            const key = sigKey(e.fsName, v, true);
            if (seen.has(key)) continue;
            seen.add(key);
            const doc = docOf(f);
            out.push(...docLines(doc, "    "), ...obsolete(doc, "    "));
            out.push(`    [<Import(${str(e.exportName!)}, ${str(e.module)})>]`);
            out.push(`    static member ${ident(e.fsName)}(${paramList(v)}) : ${ret} = nativeOnly`);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------------------
// Main

function emitEntry(e: Entry, out: Out) {
    switch (e.kind) {
        case "class":
            return emitClass(e, out);
        case "pojo":
            return emitPojo(e, out);
        case "interface":
            return emitInterface(e, out);
        case "enum":
            return emitEnum(e, out);
        case "stringenum":
            return emitStringEnum(e, out);
        case "union":
            return emitUnion(e, out);
        case "abbrev":
            return emitAbbrev(e, out);
        case "statics":
            return emitStatics(e, out);
    }
}

function relFile(f: string): string {
    return path.relative(typesDir, f).replace(/\\/g, "/");
}

function main() {
    collect();
    unifyOptionality();
    const threeVersion = JSON.parse(fs.readFileSync(path.join(root, "node_modules/three/package.json"), "utf8")).version;
    const typesVersion = JSON.parse(fs.readFileSync(path.join(typesDir, "package.json"), "utf8")).version;
    const emitted = new Map<Entry, Out>();
    const seenFunctions = new Map<Target, Set<string>>();
    // Emitting can discover types that were never exported; keep going until none are left.
    while (pending.length > 0) {
        const e = pending.shift()!;
        const out: Out = [];
        try {
            if (e.kind === "value") {
                if (e.exportName) out.push(...(literalValue(e) !== undefined ? literalLine(e) : valueLine(e)));
            } else if (e.kind === "function") {
                if (!seenFunctions.has(e.target)) seenFunctions.set(e.target, new Set());
                if (e.exportName) out.push(...functionLines(e, seenFunctions.get(e.target)!));
            } else emitEntry(e, out);
        } catch (err) {
            report.push(`failed ${e.fsName}: ${(err as Error).stack}`);
            continue;
        }
        emitted.set(e, out);
    }
    for (const target of targets) {
        const mine = entries.filter((e) => e.target === target);
        const lines: string[] = [];
        lines.push("// <auto-generated>");
        lines.push(`// Generated by tools/generate from @types/three ${typesVersion} (three ${threeVersion}).`);
        lines.push("// Do not edit by hand: change the generator or its config and run `npm run generate`.");
        lines.push("// </auto-generated>");
        lines.push(`namespace rec ${target.ns}`);
        lines.push("");
        lines.push("#nowarn \"44\" // members marked obsolete by three.js still need to be bound");
        lines.push("#nowarn \"64\"");
        lines.push("#nowarn \"1182\"");
        lines.push("#nowarn \"3370\"");
        lines.push("");
        lines.push("open Fable.Core");
        if (target !== targets[0]) lines.push("open Three");
        const byFile = new Map<string, Entry[]>();
        for (const e of mine) {
            if (!emitted.has(e) || e.kind === "value" || e.kind === "function") continue;
            const f = relFile(e.file);
            if (!byFile.has(f)) byFile.set(f, []);
            byFile.get(f)!.push(e);
        }
        for (const f of [...byFile.keys()].sort()) {
            lines.push("");
            lines.push(`// ${"-".repeat(86)}`);
            lines.push(`// ${f}`);
            for (const e of byFile.get(f)!) lines.push(...emitted.get(e)!);
        }
        const literals = mine.filter((e) => e.kind === "value" && e.exportName && literalValue(e) !== undefined);
        const values = mine.filter((e) => e.kind === "value" && e.exportName && literalValue(e) === undefined);
        if (literals.length > 0) {
            lines.push("");
            lines.push(`// ${"-".repeat(86)}`);
            lines.push("/// The module's numeric and string constants under their JS names. The enums above");
            lines.push("/// (`Side.DoubleSide`, `ColorSpace.SRGBColorSpace`) are the typed way to use them;");
            lines.push("/// these are for APIs typed as a plain number or string (`renderer.outputColorSpace`).");
            lines.push("module Constants =");
            for (const v of literals) lines.push(...(emitted.get(v) ?? []));
        }
        const functions = mine.filter((e) => e.kind === "function" && e.exportName);
        if (values.length > 0) {
            lines.push("");
            lines.push(`// ${"-".repeat(86)}`);
            lines.push("/// Constants and singletons exported by the module.");
            lines.push("[<AutoOpen>]");
            lines.push("module Values =");
            for (const v of values) lines.push(...(emitted.get(v) ?? []));
        }
        if (functions.length > 0) {
            lines.push("");
            lines.push(`// ${"-".repeat(86)}`);
            lines.push("/// Functions exported by the module.");
            lines.push("[<Erase>]");
            lines.push("type Functions =");
            for (const f of functions) lines.push(...(emitted.get(f) ?? []));
        }
        lines.push("");
        fs.writeFileSync(path.join(root, target.output), lines.join("\n"));
        console.log(`${target.output}: ${mine.length} declarations, ${lines.length} lines`);
    }
    const counts = new Map<string, number>();
    for (const e of entries) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    console.log([...counts].map(([k, v]) => `${k} ${v}`).join(", "));
    if (report.length) {
        fs.writeFileSync(path.join(root, "tools/generate/report.txt"), report.join("\n"));
        console.log(`${report.length} problems, see tools/generate/report.txt`);
        process.exitCode = 1;
    }
}

main();
