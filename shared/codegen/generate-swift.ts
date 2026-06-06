import { Project, SyntaxKind, type InterfaceDeclaration, type PropertySignature, type TypeNode } from "ts-morph";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const API_TYPES = join(__dirname, "../api-types.ts");
const OUTPUT = join(REPO_ROOT, "ConvosCore/Sources/ConvosCore/API/Generated/GoldilocksAPITypes.generated.swift");

interface SwiftField {
  name: string;
  type: string;
  isOptional: boolean;
  hasDefault: boolean;
  defaultValue: string | undefined;
  int64: boolean;
}

interface SwiftStruct {
  swiftName: string;
  fields: SwiftField[];
  isNested: boolean;
  parentName: string | undefined;
  nestedName: string | undefined;
}

const tsNameToSwiftName = new Map<string, string>();
const tsTypeAliasesToSwift = new Map<string, string>();

function parseSwiftAnnotation(iface: InterfaceDeclaration): { swiftName: string; isNested: boolean; parentName?: string; nestedName?: string } | null {
  const jsDocs = iface.getJsDocs();
  for (const doc of jsDocs) {
    const text = doc.getFullText();
    const nestedMatch = text.match(/@swift\s+nested:(\w+)\.(\w+)/);
    if (nestedMatch) {
      return { swiftName: nestedMatch[2], isNested: true, parentName: nestedMatch[1], nestedName: nestedMatch[2] };
    }
    const match = text.match(/@swift\s+(\w+)/);
    if (match) {
      return { swiftName: match[1], isNested: false };
    }
  }
  return null;
}

function tsTypeToSwift(typeNode: TypeNode | undefined, prop: PropertySignature): { swiftType: string; isOptional: boolean; int64: boolean; hasDefault: boolean; defaultValue: string | undefined } {
  if (!typeNode) return { swiftType: "Any", isOptional: false, int64: false, hasDefault: false, defaultValue: undefined };

  const propJsDocs = prop.getJsDocs();
  let int64 = false;
  let hasDefault = false;
  let defaultValue: string | undefined;

  for (const doc of propJsDocs) {
    const text = doc.getFullText();
    if (text.includes("@swift Int64")) int64 = true;
    const defaultMatch = text.match(/@swift\s+default\(([^)]+)\)/);
    if (defaultMatch) {
      hasDefault = true;
      defaultValue = defaultMatch[1];
    }
  }

  const fullText = typeNode.getText();

  if (typeNode.isKind(SyntaxKind.UnionType)) {
    const unionTypes = typeNode.asKindOrThrow(SyntaxKind.UnionType).getTypeNodes();
    const nonNull = unionTypes.filter(t => t.getText() !== "null" && t.getText() !== "undefined");
    const hasNull = unionTypes.some(t => t.getText() === "null" || t.getText() === "undefined");

    if (nonNull.length === 1 && hasNull) {
      const innerText = nonNull[0].getText();
      const inner = resolveSimpleType(innerText, int64);
      return { swiftType: inner, isOptional: true, int64, hasDefault, defaultValue };
    }

    const literals = nonNull.filter(t => t.isKind(SyntaxKind.LiteralType));
    if (literals.length === nonNull.length && literals.length > 0) {
      return { swiftType: "String", isOptional: hasNull, int64: false, hasDefault, defaultValue };
    }

    return { swiftType: "String", isOptional: hasNull, int64: false, hasDefault, defaultValue };
  }

  if (typeNode.isKind(SyntaxKind.ArrayType)) {
    const elementType = typeNode.asKindOrThrow(SyntaxKind.ArrayType).getElementTypeNode();
    const inner = resolveSimpleType(elementType.getText(), false);
    return { swiftType: `[${inner}]`, isOptional: false, int64: false, hasDefault, defaultValue };
  }

  const resolved = resolveSimpleType(fullText, int64);
  return { swiftType: resolved, isOptional: false, int64, hasDefault, defaultValue };
}

function resolveSimpleType(text: string, int64: boolean): string {
  switch (text) {
    case "string": return "String";
    case "number": return int64 ? "Int64" : "Int";
    case "boolean": return "Bool";
    default: {
      const arrayMatch = text.match(/^(\w+)\[\]$/);
      if (arrayMatch) {
        return `[${resolveSimpleType(arrayMatch[1], false)}]`;
      }
      if (tsTypeAliasesToSwift.has(text)) {
        return tsTypeAliasesToSwift.get(text)!;
      }
      if (tsNameToSwiftName.has(text)) {
        return tsNameToSwiftName.get(text)!;
      }
      return text;
    }
  }
}

function generateStruct(s: SwiftStruct, indent: string = ""): string {
  const lines: string[] = [];
  lines.push(`${indent}public struct ${s.swiftName}: Codable, Sendable {`);

  for (const f of s.fields) {
    let typeStr = f.type;
    if (f.isOptional) typeStr += "?";
    lines.push(`${indent}    public let ${f.name}: ${typeStr}`);
  }

  const needsCustomInit = s.fields.some(f => f.hasDefault);
  if (needsCustomInit) {
    lines.push("");
    const params = s.fields.map(f => {
      let typeStr = f.type;
      if (f.isOptional) typeStr += "?";
      let param = `${f.name}: ${typeStr}`;
      if (f.hasDefault) param += ` = ${f.defaultValue}`;
      else if (f.isOptional) param += ` = nil`;
      return param;
    });
    lines.push(`${indent}    public init(`);
    params.forEach((p, i) => {
      lines.push(`${indent}        ${p}${i < params.length - 1 ? "," : ""}`);
    });
    lines.push(`${indent}    ) {`);
    for (const f of s.fields) {
      lines.push(`${indent}        self.${f.name} = ${f.name}`);
    }
    lines.push(`${indent}    }`);
  }

  lines.push(`${indent}}`);
  return lines.join("\n");
}

function main() {
  const project = new Project({ tsConfigFilePath: join(__dirname, "tsconfig.json") });
  const sourceFile = project.addSourceFileAtPath(API_TYPES);

  const typeAliases = sourceFile.getTypeAliases();
  for (const alias of typeAliases) {
    const typeNode = alias.getTypeNode();
    if (typeNode && typeNode.isKind(SyntaxKind.UnionType)) {
      const unionTypes = typeNode.asKindOrThrow(SyntaxKind.UnionType).getTypeNodes();
      const literals = unionTypes.filter(t => t.isKind(SyntaxKind.LiteralType));
      if (literals.length === unionTypes.length) {
        tsTypeAliasesToSwift.set(alias.getName(), "String");
      }
    }
  }

  const interfaces = sourceFile.getInterfaces();

  for (const iface of interfaces) {
    const annotation = parseSwiftAnnotation(iface);
    if (annotation) {
      tsNameToSwiftName.set(iface.getName(), annotation.swiftName);
    }
  }

  const structs: SwiftStruct[] = [];

  for (const iface of interfaces) {
    const annotation = parseSwiftAnnotation(iface);
    if (!annotation) continue;

    const fields: SwiftField[] = [];
    for (const prop of iface.getProperties()) {
      const typeNode = prop.getTypeNode();
      const { swiftType, isOptional: typeOptional, int64, hasDefault, defaultValue } = tsTypeToSwift(typeNode, prop);
      const questionToken = prop.hasQuestionToken();

      fields.push({
        name: prop.getName(),
        type: swiftType,
        isOptional: typeOptional || questionToken,
        hasDefault,
        defaultValue,
        int64,
      });
    }

    structs.push({
      swiftName: annotation.swiftName,
      fields,
      isNested: annotation.isNested,
      parentName: annotation.parentName,
      nestedName: annotation.nestedName,
    });
  }

  const topLevel = structs.filter(s => !s.isNested);
  const nested = structs.filter(s => s.isNested);

  const nestedByParent = new Map<string, SwiftStruct[]>();
  for (const n of nested) {
    const list = nestedByParent.get(n.parentName!) ?? [];
    list.push(n);
    nestedByParent.set(n.parentName!, list);
  }

  const output: string[] = [];
  output.push("// Generated by shared/codegen/generate-swift.ts — do not edit.");
  output.push("// Source: shared/api-types.ts");
  output.push("// Regenerate: npm run codegen");
  output.push("");
  output.push("import Foundation");
  output.push("");
  output.push("// swiftlint:disable file_length");
  output.push("");

  for (const s of topLevel) {
    output.push(generateStruct(s));

    const children = nestedByParent.get(s.swiftName);
    if (children) {
      output.push("");
      output.push(`extension ${s.swiftName} {`);
      for (const child of children) {
        output.push(generateStruct(child, "    "));
      }
      output.push("}");
    }

    output.push("");
  }

  output.push("// swiftlint:enable file_length");

  const content = output.join("\n");
  const outDir = dirname(OUTPUT);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(OUTPUT, content);
  console.log(`✅  Generated ${OUTPUT}`);
  console.log(`    ${topLevel.length} top-level structs, ${nested.length} nested structs`);
}

main();
