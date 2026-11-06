import Foundation
import ImageIO
import Vision

let maximumPixels = 40_000_000

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func emit(_ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

let arguments = Array(CommandLine.arguments.dropFirst())
let normalizing = arguments.first == "--normalize"
guard arguments.count == (normalizing ? 3 : 1) else {
    fail("Usage: read-note-images.swift <image> | --normalize <image> <jpeg-output>")
}
let input = arguments[normalizing ? 1 : 0]
guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: input) as CFURL, nil),
      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
      let width = properties[kCGImagePropertyPixelWidth] as? Int,
      let height = properties[kCGImagePropertyPixelHeight] as? Int,
      width > 0, height > 0, width <= maximumPixels / height else {
    fail("Unable to read image dimensions, or image exceeds the 40 MP safety limit")
}

do {
    if normalizing {
        guard let image = CGImageSourceCreateImageAtIndex(source, 0, nil),
              let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: arguments[2]) as CFURL, "public.jpeg" as CFString, 1, nil) else {
            fail("macOS ImageIO cannot decode or convert this image")
        }
        let orientation = properties[kCGImagePropertyOrientation] as? Int ?? 1
        CGImageDestinationAddImage(destination, image, [
            kCGImageDestinationLossyCompressionQuality: 0.92,
            kCGImagePropertyOrientation: orientation,
        ] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { fail("Unable to save converted JPEG") }
        try emit(["width": width, "height": height])
    } else {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        let supported = try request.supportedRecognitionLanguages()
        request.recognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"].filter { supported.contains($0) }
        guard request.recognitionLanguages.contains("zh-Hans") else { fail("macOS Vision Chinese OCR is unavailable; update macOS and retry") }
        request.usesLanguageCorrection = true
        let handler = VNImageRequestHandler(url: URL(fileURLWithPath: input), options: [:])
        try handler.perform([request])
        // Vision uses lower-left coordinates. Keep lines top-to-bottom, left-to-right.
        let observations = (request.results ?? []).sorted {
            let leftRow = Int(($0.boundingBox.midY * 100).rounded())
            let rightRow = Int(($1.boundingBox.midY * 100).rounded())
            if leftRow != rightRow {
                return leftRow > rightRow
            }
            return $0.boundingBox.minX < $1.boundingBox.minX
        }
        let text = observations.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
        try emit(["text": text, "width": width, "height": height])
    }
} catch {
    fail("Local image processing failed: \(error.localizedDescription)")
}
