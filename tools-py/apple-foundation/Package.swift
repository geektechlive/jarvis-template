// swift-tools-version:6.0
import PackageDescription

// afm -- Apple Foundation Models inference helper.
// A persistent process that reads newline-delimited JSON requests on stdin and
// writes one JSON response line per request to stdout. FoundationModels is a
// Swift-only framework, so this binary is the only thing that touches the model;
// the Python server (server.py) fronts it with HTTP and keeps it warm.
let package = Package(
    name: "afm",
    platforms: [.macOS("26.0")],
    targets: [
        .executableTarget(
            name: "afm",
            path: "Sources/afm"
        )
    ]
)
