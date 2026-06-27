import FoundationModels
import Foundation

// afm: Apple Foundation Models inference helper.
//
// Protocol: one JSON object per line on stdin, one JSON response line on stdout.
//   Request:  {"id","mode":"health"|"generate"|"generate_typed",
//              "prompt"?,"instructions"?,"schema"?}
//   Response: {"id","ok":true,"content":"..."} | {"id","ok":false,"error":"..."}
//
// generate_typed.content is itself a JSON STRING (the structured result) the
// caller parses. The schema is a flat object of properties -- enough for the
// classification/tagging roles we target; not a full JSON-Schema compiler.

struct PropSpec: Decodable {
    let name: String
    let type: String  // "string" | "string[]" | "number" | "boolean"
    var description: String?
    var `enum`: [String]?
}

struct SchemaSpec: Decodable {
    let properties: [PropSpec]
}

struct Req: Decodable {
    let id: String
    let mode: String
    var prompt: String?
    var instructions: String?
    var schema: SchemaSpec?
}

let stdoutHandle = FileHandle.standardOutput
let stderrHandle = FileHandle.standardError

func logErr(_ s: String) {
    stderrHandle.write((s + "\n").data(using: .utf8)!)
}

func writeResponse(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
    stdoutHandle.write(data)
    stdoutHandle.write("\n".data(using: .utf8)!)
}

@available(macOS 26.0, *)
func availabilityString(_ model: SystemLanguageModel) -> String {
    switch model.availability {
    case .available:
        return "available"
    case .unavailable(let reason):
        return "unavailable: \(reason)"
    @unknown default:
        return "unknown"
    }
}

// Build a runtime guided-generation schema from the flat property spec. No
// @Generable macro (the macro plugin ships only with full Xcode; this binary
// builds on Command Line Tools).
@available(macOS 26.0, *)
func buildSchema(_ spec: SchemaSpec) throws -> GenerationSchema {
    var props: [DynamicGenerationSchema.Property] = []
    for p in spec.properties {
        let inner: DynamicGenerationSchema
        switch p.type {
        case "string[]":
            inner = DynamicGenerationSchema(arrayOf: DynamicGenerationSchema(type: String.self))
        case "number":
            inner = DynamicGenerationSchema(type: Double.self)
        case "boolean":
            inner = DynamicGenerationSchema(type: Bool.self)
        default:  // "string"
            if let choices = p.enum, !choices.isEmpty {
                inner = DynamicGenerationSchema(name: "\(p.name)_enum", anyOf: choices)
            } else {
                inner = DynamicGenerationSchema(type: String.self)
            }
        }
        props.append(
            DynamicGenerationSchema.Property(name: p.name, description: p.description, schema: inner)
        )
    }
    let root = DynamicGenerationSchema(name: "Result", properties: props)
    return try GenerationSchema(root: root, dependencies: [])
}

@available(macOS 26.0, *)
func handle(_ req: Req, model: SystemLanguageModel) async {
    // Reject everything cleanly if the model isn't usable, so callers fall back.
    guard case .available = model.availability else {
        writeResponse(["id": req.id, "ok": false, "error": availabilityString(model)])
        return
    }
    do {
        switch req.mode {
        case "health":
            writeResponse(["id": req.id, "ok": true, "content": "available"])
        case "generate":
            let session = LanguageModelSession(instructions: req.instructions ?? "")
            let r = try await session.respond(to: req.prompt ?? "")
            writeResponse(["id": req.id, "ok": true, "content": r.content])
        case "generate_typed":
            guard let spec = req.schema else {
                writeResponse(["id": req.id, "ok": false, "error": "schema required"])
                return
            }
            let schema = try buildSchema(spec)
            let session = LanguageModelSession(instructions: req.instructions ?? "")
            let r = try await session.respond(to: req.prompt ?? "", schema: schema)
            // GeneratedContent's textual form is JSON; pass it through as a string.
            writeResponse(["id": req.id, "ok": true, "content": "\(r.content)"])
        default:
            writeResponse(["id": req.id, "ok": false, "error": "unknown mode: \(req.mode)"])
        }
    } catch {
        writeResponse(["id": req.id, "ok": false, "error": "\(error)"])
    }
}

@main
struct AFM {
    static func main() async {
        guard #available(macOS 26.0, *) else {
            logErr("afm: macOS 26.0+ required")
            return
        }
        let model = SystemLanguageModel.default
        let avail = availabilityString(model)
        // Prewarm so the first real request doesn't pay the model-load cost.
        if case .available = model.availability {
            let warm = LanguageModelSession(instructions: "Reply OK.")
            _ = try? await warm.respond(to: "ping")
        }
        logErr("afm ready: \(avail)")

        let decoder = JSONDecoder()
        while let line = readLine(strippingNewline: true) {
            if line.isEmpty { continue }
            guard let data = line.data(using: .utf8), let req = try? decoder.decode(Req.self, from: data) else {
                writeResponse(["id": "", "ok": false, "error": "bad request json"])
                continue
            }
            await handle(req, model: model)
        }
    }
}
