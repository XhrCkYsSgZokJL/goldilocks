import { Project, SyntaxKind, type InterfaceDeclaration, type PropertySignature, type TypeNode } from "ts-morph";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_TYPES = join(__dirname, "../api-types.ts");
const OUTPUT = join(__dirname, "../../backend/src/generated/api-schemas.ts");

interface ZodField {
  name: string;
  zodType: string;
  optional: boolean;
}

interface ZodSchema {
  exportName: string;
  tsName: string;
  fields: ZodField[];
  deps: string[];
}

const tsNameToExportName = new Map<string, string>();

function getSwiftAnnotation(iface: InterfaceDeclaration): { swiftName: string; isNested: boolean; parentName?: string } | null {
  for (const doc of iface.getJsDocs()) {
    const text = doc.getFullText();
    const nestedMatch = text.match(/@swift\s+nested:(\w+)\.(\w+)/);
    if (nestedMatch) {
      return { swiftName: nestedMatch[2], isNested: true, parentName: nestedMatch[1] };
    }
    const match = text.match(/@swift\s+(\w+)/);
    if (match) {
      return { swiftName: match[1], isNested: false };
    }
  }
  return null;
}

function toExportName(swiftName: string): string {
  const stripped = swiftName.replace(/^Goldilocks/, "");
  return stripped.charAt(0).toLowerCase() + stripped.slice(1) + "Schema";
}

function tsTypeToZod(typeNode: TypeNode | undefined, prop: PropertySignature): { zodType: string; optional: boolean; deps: string[] } {
  if (!typeNode) return { zodType: "z.unknown()", optional: false, deps: [] };

  const fullText = typeNode.getText();
  const deps: string[] = [];

  if (typeNode.isKind(SyntaxKind.UnionType)) {
    const unionTypes = typeNode.asKindOrThrow(SyntaxKind.UnionType).getTypeNodes();
    const nonNull = unionTypes.filter(t => t.getText() !== "null" && t.getText() !== "undefined");
    const hasNull = unionTypes.some(t => t.getText() === "null" || t.getText() === "undefined");

    if (nonNull.length === 1 && hasNull) {
      const { zod, dep } = resolveTypeToZod(nonNull[0].getText());
      if (dep) deps.push(dep);
      return { zodType: `${zod}.nullable()`, optional: false, deps };
    }

    const literals = nonNull.filter(t => t.isKind(SyntaxKind.LiteralType));
    if (literals.length === nonNull.length && literals.length > 0) {
      const values = literals.map(l => l.getText());
      const enumSchema = `z.enum([${values.join(", ")}])`;
      return { zodType: hasNull ? `${enumSchema}.nullable()` : enumSchema, optional: false, deps };
    }

    return { zodType: "z.string()", optional: hasNull, deps };
  }

  if (typeNode.isKind(SyntaxKind.ArrayType)) {
    const elementType = typeNode.asKindOrThrow(SyntaxKind.ArrayType).getElementTypeNode();
    const { zod, dep } = resolveTypeToZod(elementType.getText());
    if (dep) deps.push(dep);
    return { zodType: `z.array(${zod})`, optional: false, deps };
  }

  const { zod, dep } = resolveTypeToZod(fullText);
  if (dep) deps.push(dep);
  return { zodType: zod, optional: false, deps };
}

function resolveTypeToZod(text: string): { zod: string; dep: string | null } {
  switch (text) {
    case "string": return { zod: "z.string()", dep: null };
    case "number": return { zod: "z.number()", dep: null };
    case "boolean": return { zod: "z.boolean()", dep: null };
    default: {
      const arrayMatch = text.match(/^(\w+)\[\]$/);
      if (arrayMatch) {
        const inner = resolveTypeToZod(arrayMatch[1]);
        return { zod: `z.array(${inner.zod})`, dep: inner.dep };
      }
      const exportName = tsNameToExportName.get(text);
      if (exportName) {
        return { zod: exportName, dep: text };
      }
      const camel = text.charAt(0).toLowerCase() + text.slice(1) + "Schema";
      return { zod: camel, dep: text };
    }
  }
}

function topoSort(schemas: ZodSchema[]): ZodSchema[] {
  const byTsName = new Map<string, ZodSchema>();
  for (const s of schemas) byTsName.set(s.tsName, s);

  const visited = new Set<string>();
  const result: ZodSchema[] = [];

  function visit(s: ZodSchema) {
    if (visited.has(s.tsName)) return;
    visited.add(s.tsName);
    for (const dep of s.deps) {
      const depSchema = byTsName.get(dep);
      if (depSchema) visit(depSchema);
    }
    result.push(s);
  }

  for (const s of schemas) visit(s);
  return result;
}

function main() {
  const project = new Project({ tsConfigFilePath: join(__dirname, "tsconfig.json") });
  const sourceFile = project.addSourceFileAtPath(API_TYPES);

  const interfaces = sourceFile.getInterfaces();
  const typeAliases = sourceFile.getTypeAliases();

  for (const iface of interfaces) {
    const annotation = getSwiftAnnotation(iface);
    if (annotation) {
      tsNameToExportName.set(iface.getName(), toExportName(annotation.swiftName));
    }
  }

  const enumAliases: { tsName: string; exportName: string; values: string[] }[] = [];
  for (const alias of typeAliases) {
    const typeNode = alias.getTypeNode();
    if (typeNode && typeNode.isKind(SyntaxKind.UnionType)) {
      const unionTypes = typeNode.asKindOrThrow(SyntaxKind.UnionType).getTypeNodes();
      const literals = unionTypes.filter(t => t.isKind(SyntaxKind.LiteralType));
      if (literals.length === unionTypes.length && literals.length > 0) {
        const name = alias.getName();
        const exportName = name.charAt(0).toLowerCase() + name.slice(1) + "Schema";
        tsNameToExportName.set(name, exportName);
        enumAliases.push({
          tsName: name,
          exportName,
          values: literals.map(l => l.getText()),
        });
      }
    }
  }

  const schemas: ZodSchema[] = [];

  for (const iface of interfaces) {
    const annotation = getSwiftAnnotation(iface);
    if (!annotation) continue;

    const fields: ZodField[] = [];
    const allDeps: string[] = [];
    for (const prop of iface.getProperties()) {
      const typeNode = prop.getTypeNode();
      const { zodType, optional: typeOptional, deps } = tsTypeToZod(typeNode, prop);
      const questionToken = prop.hasQuestionToken();
      allDeps.push(...deps);

      fields.push({
        name: prop.getName(),
        zodType,
        optional: typeOptional || questionToken,
      });
    }

    schemas.push({
      exportName: toExportName(annotation.swiftName),
      tsName: iface.getName(),
      fields,
      deps: allDeps,
    });
  }

  const sorted = topoSort(schemas);

  const output: string[] = [];
  output.push("// Generated by shared/codegen/generate-zod.ts — do not edit.");
  output.push("// Source: shared/api-types.ts");
  output.push("// Regenerate: npm run codegen");
  output.push("");
  output.push('import { z } from "zod";');
  output.push("");

  for (const ea of enumAliases) {
    output.push(`export const ${ea.exportName} = z.enum([${ea.values.join(", ")}]);`);
    output.push("");
    const typeName = ea.tsName.charAt(0).toUpperCase() + ea.tsName.slice(1);
    output.push(`export type ${typeName} = z.infer<typeof ${ea.exportName}>;`);
    output.push("");
  }

  for (const s of sorted) {
    output.push(`export const ${s.exportName} = z.object({`);
    for (const f of s.fields) {
      let line = `  ${f.name}: ${f.zodType}`;
      if (f.optional) line += ".optional()";
      line += ",";
      output.push(line);
    }
    output.push("});");
    output.push("");
    const typeName = s.exportName.replace(/Schema$/, "");
    const capitalTypeName = typeName.charAt(0).toUpperCase() + typeName.slice(1);
    output.push(`export type ${capitalTypeName} = z.infer<typeof ${s.exportName}>;`);
    output.push("");
  }

  const content = output.join("\n");
  const outDir = dirname(OUTPUT);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(OUTPUT, content);
  console.log(`✅  Generated ${OUTPUT}`);
  console.log(`    ${sorted.length} schemas, ${enumAliases.length} enums`);
}

main();
